use crate::{NativePaseoDesktopEvents, NativePaseoDesktopSpec};
use rn_gpui_module::ModuleError;
use std::io::Read;

pub struct PaseoDesktop {
    database: std::sync::Mutex<Option<rusqlite::Connection>>,
}
impl PaseoDesktop {
    fn database(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<rusqlite::Connection>>, ModuleError> {
        let mut guard = self
            .database
            .lock()
            .map_err(|e| ModuleError::new(e.to_string()))?;
        if guard.is_none() {
            let base = std::env::var("XDG_DATA_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| {
                    std::path::PathBuf::from(std::env::var("HOME").expect("HOME is set"))
                        .join(".local/share")
                });
            let dir = base.join("paseo-gpui");
            std::fs::create_dir_all(&dir).map_err(|e| ModuleError::new(e.to_string()))?;
            *guard = Some(
                rusqlite::Connection::open(dir.join("replica.db"))
                    .map_err(|e| ModuleError::new(e.to_string()))?,
            );
        }
        Ok(guard)
    }
}
impl NativePaseoDesktopSpec for PaseoDesktop {
    fn new(_events: NativePaseoDesktopEvents) -> Self {
        Self {
            database: std::sync::Mutex::new(None),
        }
    }
    fn sqlite(&self, sql: String, params: String) -> Result<String, ModuleError> {
        let fail = |e: rusqlite::Error| ModuleError::new(e.to_string());
        let db = self.database()?;
        let db = db.as_ref().unwrap();
        if params == "batch" {
            db.execute_batch(&sql).map_err(fail)?;
            return Ok("[]".into());
        }
        let values: Vec<serde_json::Value> =
            serde_json::from_str(&params).map_err(|e| ModuleError::new(e.to_string()))?;
        let values: Vec<rusqlite::types::Value> = values
            .into_iter()
            .map(|v| match v {
                serde_json::Value::Null => rusqlite::types::Value::Null,
                serde_json::Value::String(v) => rusqlite::types::Value::Text(v),
                serde_json::Value::Number(v) => v
                    .as_i64()
                    .map(rusqlite::types::Value::Integer)
                    .unwrap_or_else(|| rusqlite::types::Value::Real(v.as_f64().unwrap())),
                _ => rusqlite::types::Value::Text(v.to_string()),
            })
            .collect();
        let mut stmt = db.prepare(&sql).map_err(fail)?;
        let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        let mut rows = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(fail)?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(fail)? {
            let mut object = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index).map_err(fail)? {
                    rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                    rusqlite::types::ValueRef::Integer(v) => v.into(),
                    rusqlite::types::ValueRef::Real(v) => serde_json::json!(v),
                    rusqlite::types::ValueRef::Text(v) => {
                        String::from_utf8_lossy(v).into_owned().into()
                    }
                    rusqlite::types::ValueRef::Blob(_) => {
                        return Err(ModuleError::new(
                            "Replica store does not support blob columns",
                        ))
                    }
                };
                object.insert(name.clone(), value);
            }
            results.push(object);
        }
        serde_json::to_string(&results).map_err(|e| ModuleError::new(e.to_string()))
    }
    fn timezone(&self) -> Result<String, ModuleError> {
        if let Ok(zone) = std::env::var("TZ") {
            if !zone.is_empty() {
                return Ok(zone.trim_start_matches(':').into());
            }
        }
        if let Ok(path) = std::fs::read_link("/etc/localtime") {
            if let Some((_, zone)) = path.to_string_lossy().split_once("/zoneinfo/") {
                return Ok(zone.into());
            }
        }
        Ok(std::fs::read_to_string("/etc/timezone")
            .map(|s| s.trim().into())
            .unwrap_or_else(|_| "UTC".into()))
    }
    fn locale(&self) -> Result<String, ModuleError> {
        Ok(["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
            .unwrap_or_else(|| "en_US.UTF-8".into()))
    }
    fn sha256(&self, text: String) -> Result<String, ModuleError> {
        use sha2::{Digest, Sha256};
        Ok(format!("{:x}", Sha256::digest(text.as_bytes())))
    }
    fn random_bytes(&self, length: f64) -> Result<Vec<f64>, ModuleError> {
        if !length.is_finite() || length < 0.0 || length > 65536.0 || length.fract() != 0.0 {
            return Err(ModuleError::new("Invalid random byte count"));
        }
        let mut bytes = vec![0u8; length as usize];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .map_err(|error| ModuleError::new(error.to_string()))?;
        Ok(bytes.into_iter().map(f64::from).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> PaseoDesktop {
        PaseoDesktop {
            database: std::sync::Mutex::new(Some(rusqlite::Connection::open_in_memory().unwrap())),
        }
    }
    #[test]
    fn crypto_matches_sha256_and_bounds_random_requests() {
        let service = service();
        assert_eq!(
            service.sha256("abc".into()).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(service.random_bytes(32.0).unwrap().len(), 32);
        assert!(service.random_bytes(65537.0).is_err());
        assert!(service.random_bytes(-1.0).is_err());
    }
    #[test]
    fn replica_transactions_bind_values_and_roll_back() {
        let service = service();
        service
            .sqlite(
                "CREATE TABLE rows (key TEXT PRIMARY KEY, value TEXT);".into(),
                "batch".into(),
            )
            .unwrap();
        service
            .sqlite(
                "INSERT INTO rows VALUES (?, ?)".into(),
                r#"["key","quoted ' value"]"#.into(),
            )
            .unwrap();
        service
            .sqlite(
                "BEGIN IMMEDIATE; DELETE FROM rows; ROLLBACK;".into(),
                "batch".into(),
            )
            .unwrap();
        let result = service
            .sqlite("SELECT key, value FROM rows".into(), "[]".into())
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&result).unwrap(),
            serde_json::json!([{"key":"key","value":"quoted ' value"}])
        );
    }
}
