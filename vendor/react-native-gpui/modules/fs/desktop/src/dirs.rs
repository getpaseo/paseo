//! Listing, creating and removing directories, and `mkdtemp`.
//!
//! `readdir` returns every entry as a plain `{name, kind, parentPath}` object,
//! which the JS layer turns into `Dirent` instances; there is no per-directory
//! cursor to hold open because the whole listing crosses the bridge at once.

use std::fs;
use std::path::{Path, PathBuf};

use rn_gpui_module::ModuleError;

use crate::errors;
use crate::module::kind;
use crate::DirEntry;

pub async fn readdir(path: String, recursive: bool) -> Result<Vec<DirEntry>, ModuleError> {
    readdir_sync(path, recursive)
}

pub async fn mkdir(path: String, recursive: bool, mode: f64) -> Result<(), ModuleError> {
    create_dir(&path, recursive, mode)
}

pub async fn rm(path: String, recursive: bool, force: bool) -> Result<(), ModuleError> {
    remove(&path, recursive, force)
}

pub async fn mkdtemp(prefix: String) -> Result<String, ModuleError> {
    let directory = tempfile::Builder::new()
        .prefix(&prefix)
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| errors::from_io(error, &prefix))?;
    // The caller asked for a directory to keep, so it must outlive this frame;
    // dropping the guard would delete it again.
    Ok(path_string(directory.keep()))
}

pub fn readdir_sync(path: String, recursive: bool) -> Result<Vec<DirEntry>, ModuleError> {
    let entries = list(Path::new(&path))?;
    if !recursive {
        return Ok(entries);
    }
    let mut collected = entries;
    // Depth-first, appending each level as it is reached. Iterative rather than
    // recursive: a deep tree should cost heap, not stack.
    let mut pending: Vec<PathBuf> = collected
        .iter()
        .filter(|entry| entry.kind == kind::DIRECTORY)
        .map(|entry| Path::new(&entry.parent_path).join(&entry.name))
        .collect();
    while let Some(directory) = pending.pop() {
        let children = list(&directory)?;
        pending.extend(
            children
                .iter()
                .filter(|entry| entry.kind == kind::DIRECTORY)
                .map(|entry| Path::new(&entry.parent_path).join(&entry.name)),
        );
        collected.extend(children);
    }
    Ok(collected)
}

pub fn mkdir_sync(path: String, recursive: bool, mode: f64) -> Result<bool, ModuleError> {
    create_dir(&path, recursive, mode)?;
    Ok(true)
}

pub fn rm_sync(path: String, recursive: bool, force: bool) -> Result<bool, ModuleError> {
    remove(&path, recursive, force)?;
    Ok(true)
}

/// The direct children of `path`, in the order the file system lists them.
///
/// `DirEntry::file_type` does not follow symbolic links, so a link is reported
/// as a link rather than as whatever it points at.
fn list(path: &Path) -> Result<Vec<DirEntry>, ModuleError> {
    let name = path_string(path.to_path_buf());
    let iterator = fs::read_dir(path).map_err(|error| errors::from_io(error, &name))?;
    let mut entries = Vec::new();
    for entry in iterator {
        let entry = entry.map_err(|error| errors::from_io(error, &name))?;
        let file_type = entry
            .file_type()
            .map_err(|error| errors::from_io(error, &name))?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: entry_kind(&file_type),
            parent_path: name.clone(),
        });
    }
    Ok(entries)
}

fn entry_kind(file_type: &fs::FileType) -> f64 {
    if file_type.is_file() {
        kind::FILE
    } else if file_type.is_dir() {
        kind::DIRECTORY
    } else if file_type.is_symlink() {
        kind::SYMLINK
    } else {
        kind::OTHER
    }
}

fn create_dir(path: &str, recursive: bool, mode: f64) -> Result<(), ModuleError> {
    if recursive {
        // `create_dir_all` succeeds on an existing directory, which is what
        // Node's `{recursive: true}` promises.
        return fs::create_dir_all(path).map_err(|error| errors::from_io(error, path));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        let mut builder = fs::DirBuilder::new();
        builder.mode(crate::module::mode(mode));
        builder
            .create(path)
            .map_err(|error| errors::from_io(error, path))
    }
    // Windows has no mode for a new directory, and `create_dir` would reject
    // the `DirBuilder` extension that only exists on Unix.
    #[cfg(not(unix))]
    {
        let _ = mode;
        fs::create_dir(path).map_err(|error| errors::from_io(error, path))
    }
}

fn remove(path: &str, recursive: bool, force: bool) -> Result<(), ModuleError> {
    // `symlink_metadata`, so a link is removed as a link instead of acting on
    // its target.
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if force && errors::code_for(&error) == "ENOENT" => return Ok(()),
        Err(error) => return Err(errors::from_io(error, path)),
    };
    if recursive && metadata.is_dir() {
        return fs::remove_dir_all(path).map_err(|error| errors::from_io(error, path));
    }
    if metadata.is_dir() {
        // `remove_dir` fails with ENOTEMPTY on Unix and a folder-not-empty error
        // on Windows, which the mapping turns into the same code; removing a
        // file with it reports what Node calls ENOTDIR.
        fs::remove_dir(path).map_err(|error| errors::from_io(error, path))
    } else {
        fs::remove_file(path).map_err(|error| errors::from_io(error, path))
    }
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The async wrappers never suspend, so polling once with a no-op waker is
    /// enough and keeps the tests independent of a runtime.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        // One poll, no loop: these helpers do their work inline, so a `Pending`
        // would mean the helper is not synchronous after all, which the test
        // should fail loudly on rather than spin.
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("the wrappers are synchronous"),
        }
    }

    fn tempdir() -> TempDir {
        TempDir::new().expect("a temporary directory")
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// The listed paths, with separators normalised to `/`.
    ///
    /// The entries themselves carry the platform separator, which on Windows is
    /// `\`; building the expected path with `/` and comparing would test the
    /// separator rather than the listing.
    fn names(entries: &[DirEntry]) -> Vec<String> {
        let mut names: Vec<String> = entries
            .iter()
            .map(|entry| format!("{}/{}", entry.parent_path, entry.name).replace('\\', "/"))
            .collect();
        names.sort();
        names
    }

    fn tree(root: &Path) {
        fs::create_dir_all(root.join("nested").join("deep")).expect("nested");
        fs::write(root.join("top.txt"), b"top").expect("seed");
        fs::write(root.join("nested").join("middle.txt"), b"middle").expect("seed");
        fs::write(root.join("nested").join("deep").join("leaf.txt"), b"leaf").expect("seed");
    }

    #[test]
    fn readdir_lists_direct_children_only() {
        let dir = tempdir();
        tree(dir.path());

        let entries = readdir_sync(text(dir.path()), false).expect("readdir");
        // `names` normalises separators, so the expected paths are built from a
        // normalised root rather than the platform one.
        let root = text(dir.path()).replace('\\', "/");
        assert_eq!(
            names(&entries),
            vec![format!("{root}/nested"), format!("{root}/top.txt")]
        );

        let top = entries
            .iter()
            .find(|entry| entry.name == "top.txt")
            .expect("top.txt");
        assert_eq!(top.kind, kind::FILE);
        assert_eq!(top.parent_path, text(dir.path()));
        let nested = entries
            .iter()
            .find(|entry| entry.name == "nested")
            .expect("nested");
        assert_eq!(nested.kind, kind::DIRECTORY);
    }

    #[test]
    fn readdir_recursive_reaches_every_descendant() {
        let dir = tempdir();
        tree(dir.path());

        let entries = block_on(readdir(text(dir.path()), true)).expect("readdir");
        // Two entries per directory, three directories deep.
        assert_eq!(entries.len(), 5);
        let listed = names(&entries);
        let root = text(dir.path()).replace('\\', "/");
        assert!(listed.contains(&format!("{root}/nested/deep/leaf.txt")));
        assert!(listed.contains(&format!("{root}/nested/deep")));

        let deep = entries
            .iter()
            .find(|entry| entry.name == "deep")
            .expect("deep");
        assert_eq!(
            deep.parent_path,
            text(&dir.path().join("nested")),
            "parentPath is the containing directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn readdir_reports_a_link_as_a_link() {
        let dir = tempdir();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"x").expect("seed");
        std::os::unix::fs::symlink(&target, dir.path().join("link.txt")).expect("symlink");

        let entries = readdir_sync(text(dir.path()), false).expect("readdir");
        let link = entries
            .iter()
            .find(|entry| entry.name == "link.txt")
            .expect("link.txt");
        assert_eq!(link.kind, kind::SYMLINK);
    }

    #[test]
    fn mkdir_with_recursive_creates_the_chain_and_accepts_an_existing_dir() {
        let dir = tempdir();
        let nested = dir.path().join("a").join("b").join("c");

        block_on(mkdir(text(&nested), true, f64::from(0o755u32))).expect("mkdir");
        assert!(nested.is_dir());

        let again = mkdir_sync(text(&nested), true, f64::from(0o755u32)).expect("mkdir again");
        assert!(again, "recursive mkdir succeeds when the path exists");
    }

    #[test]
    fn mkdir_without_recursive_fails_with_eexist() {
        let dir = tempdir();
        let path = dir.path().join("single");
        assert!(mkdir_sync(text(&path), false, f64::from(0o755u32)).expect("mkdir"));
        assert!(path.is_dir());

        let error =
            block_on(mkdir(text(&path), false, f64::from(0o755u32))).expect_err("mkdir twice");
        assert_eq!(error.code.as_deref(), Some("EEXIST"));

        let missing_parent = text(&dir.path().join("no").join("such").join("dir"));
        let error =
            mkdir_sync(missing_parent, false, f64::from(0o755u32)).expect_err("missing parent");
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
    }

    #[test]
    fn rm_force_ignores_a_missing_path() {
        let dir = tempdir();
        let missing = text(&dir.path().join("absent"));

        block_on(rm(missing.clone(), false, true)).expect("rm force");
        assert!(rm_sync(missing.clone(), true, true).expect("rm sync force"));

        let error = block_on(rm(missing, false, false)).expect_err("rm without force");
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
    }

    #[test]
    fn rm_removes_a_file_and_a_tree() {
        let dir = tempdir();
        let file = dir.path().join("one.txt");
        fs::write(&file, b"x").expect("seed");
        block_on(rm(text(&file), false, false)).expect("rm file");
        assert!(!file.exists());

        let root = dir.path().join("tree");
        tree(&root);
        assert!(rm_sync(text(&root), true, false).expect("rm tree"));
        assert!(!root.exists());
    }

    #[test]
    fn rm_without_recursive_refuses_a_non_empty_directory() {
        let dir = tempdir();
        let root = dir.path().join("tree");
        tree(&root);

        let error = block_on(rm(text(&root), false, false)).expect_err("non-empty");
        assert_eq!(error.code.as_deref(), Some("ENOTEMPTY"));
        assert!(root.exists());
    }

    #[test]
    fn mkdtemp_creates_a_random_directory_with_the_prefix() {
        let created = block_on(mkdtemp("rn-gpui-fs-".to_string())).expect("mkdtemp");
        let path = Path::new(&created);
        let name = path
            .file_name()
            .expect("the returned path names a directory")
            .to_string_lossy()
            .into_owned();

        assert!(name.starts_with("rn-gpui-fs-"), "name was {name}");
        assert!(name.len() > "rn-gpui-fs-".len(), "the rest is random");
        assert!(path.is_dir());
        assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));

        fs::remove_dir_all(path).expect("clean up");
    }

    #[test]
    fn readdir_of_a_missing_directory_is_enoent() {
        let dir = tempdir();
        let error = readdir_sync(text(&dir.path().join("absent")), false).expect_err("readdir");
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
    }
}
