//! `@react-native-gpui/fs`: a Node-shaped file API for the desktop app.
//!
//! The TypeScript spec in `../src/NativeFs.ts` is the contract; the generator
//! turns it into the `NativeFsSpec` trait implemented here. That trait is the
//! only thing the C++ bridge knows about, so the API surface is edited there and
//! regenerated, never in this file.
//!
//! Rust needs a trait's methods in a single `impl` block, so this file holds that
//! block and hands each method to a helper in the file that owns the concern:
//!
//! - `files` — reading, writing, copying, truncating, permissions and times
//! - `dirs` — listing, creating, removing and `mkdtemp`
//! - `handles` — open descriptors, positioned reads and writes
//! - `links` — symbolic links, `realpath` and `access`
//! - `paths` — the well-known folders, created on first read
//! - `dialogs` — the pickers, `reveal` and `openExternal`
//! - `watching` — the watcher behind `watch` and `unwatch`
//!
//! Keeping the bodies in those files is what makes the crate readable; keeping
//! the `impl` here is what makes it compile.

rn_gpui_module::include_specs!();

mod dialogs;
mod dirs;
mod errors;
mod files;
mod handles;
mod links;
mod module;
mod paths;
mod watching;

pub use module::RNFsModule;

use rn_gpui_module::{ArrayBuffer, ModuleError};

impl NativeFsSpec for RNFsModule {
    fn new(events: NativeFsEvents) -> Self {
        Self::create(events)
    }

    async fn read_file(&self, path: String) -> Result<ArrayBuffer, ModuleError> {
        files::read_file(path).await
    }

    async fn read_text_file(&self, path: String) -> Result<String, ModuleError> {
        files::read_text_file(path).await
    }

    async fn write_file(
        &self,
        path: String,
        data: ArrayBuffer,
        flags: f64,
        mode: f64,
    ) -> Result<(), ModuleError> {
        files::write_file(path, data, flags, mode).await
    }

    async fn write_text_file(
        &self,
        path: String,
        data: String,
        flags: f64,
        mode: f64,
    ) -> Result<(), ModuleError> {
        files::write_text_file(path, data, flags, mode).await
    }

    async fn readdir(&self, path: String, recursive: bool) -> Result<Vec<DirEntry>, ModuleError> {
        dirs::readdir(path, recursive).await
    }

    async fn stat(&self, path: String, follow_symlinks: bool) -> Result<StatResult, ModuleError> {
        files::stat(path, follow_symlinks).await
    }

    async fn mkdir(&self, path: String, recursive: bool, mode: f64) -> Result<(), ModuleError> {
        dirs::mkdir(path, recursive, mode).await
    }

    async fn rm(&self, path: String, recursive: bool, force: bool) -> Result<(), ModuleError> {
        dirs::rm(path, recursive, force).await
    }

    async fn rename(&self, from: String, to: String) -> Result<(), ModuleError> {
        files::rename(from, to).await
    }

    async fn copy(&self, from: String, to: String, recursive: bool) -> Result<(), ModuleError> {
        files::copy(from, to, recursive).await
    }

    async fn access(&self, path: String, mode: f64) -> Result<(), ModuleError> {
        links::access(path, mode)
    }

    async fn realpath(&self, path: String) -> Result<String, ModuleError> {
        links::realpath(path)
    }

    async fn readlink(&self, path: String) -> Result<String, ModuleError> {
        links::readlink(path)
    }

    async fn symlink(
        &self,
        target: String,
        path: String,
        kind: Option<String>,
    ) -> Result<(), ModuleError> {
        links::symlink(target, path, kind.as_deref())
    }

    async fn truncate(&self, path: String, length: f64) -> Result<(), ModuleError> {
        files::truncate(path, length).await
    }

    async fn utimes(&self, path: String, atime_ms: f64, mtime_ms: f64) -> Result<(), ModuleError> {
        files::utimes(path, atime_ms, mtime_ms).await
    }

    async fn chmod(&self, path: String, mode: f64) -> Result<(), ModuleError> {
        files::chmod(path, mode).await
    }

    async fn mkdtemp(&self, prefix: String) -> Result<String, ModuleError> {
        dirs::mkdtemp(prefix).await
    }

    async fn open(&self, path: String, flags: f64, mode: f64) -> Result<f64, ModuleError> {
        handles::open(self, path, flags, mode)
    }

    async fn read(&self, fd: f64, length: f64, position: f64) -> Result<ArrayBuffer, ModuleError> {
        handles::read(self, fd, length, position)
    }

    async fn write(&self, fd: f64, data: ArrayBuffer, position: f64) -> Result<f64, ModuleError> {
        handles::write(self, fd, data, position)
    }

    async fn fstat(&self, fd: f64) -> Result<StatResult, ModuleError> {
        handles::fstat(self, fd)
    }

    async fn fsync(&self, fd: f64) -> Result<(), ModuleError> {
        handles::fsync(self, fd)
    }

    async fn ftruncate(&self, fd: f64, length: f64) -> Result<(), ModuleError> {
        handles::ftruncate(self, fd, length)
    }

    async fn close(&self, fd: f64) -> Result<(), ModuleError> {
        handles::close(self, fd)
    }

    async fn show_open_dialog(
        &self,
        options: OpenDialogOptions,
    ) -> Result<Vec<String>, ModuleError> {
        dialogs::show_open(options)
    }

    async fn show_save_dialog(
        &self,
        options: SaveDialogOptions,
    ) -> Result<Option<String>, ModuleError> {
        dialogs::show_save(options)
    }

    async fn reveal(&self, path: String) -> Result<(), ModuleError> {
        dialogs::reveal(path)
    }

    async fn open_external(&self, path: String) -> Result<(), ModuleError> {
        dialogs::open_external(path)
    }

    async fn watch(&self, path: String, recursive: bool) -> Result<f64, ModuleError> {
        watching::watch(self, path, recursive)
    }

    fn unwatch(&self, id: f64) {
        watching::unwatch(self, id);
    }

    fn read_file_sync(&self, path: String) -> Result<ArrayBuffer, ModuleError> {
        files::read_file_sync(path)
    }

    fn read_text_file_sync(&self, path: String) -> Result<String, ModuleError> {
        files::read_text_file_sync(path)
    }

    fn write_file_sync(
        &self,
        path: String,
        data: ArrayBuffer,
        flags: f64,
        mode: f64,
    ) -> Result<bool, ModuleError> {
        files::write_file_sync(path, data, flags, mode)
    }

    fn write_text_file_sync(
        &self,
        path: String,
        data: String,
        flags: f64,
        mode: f64,
    ) -> Result<bool, ModuleError> {
        files::write_text_file_sync(path, data, flags, mode)
    }

    fn stat_sync(
        &self,
        path: String,
        follow_symlinks: bool,
    ) -> Result<Option<StatResult>, ModuleError> {
        files::stat_sync(path, follow_symlinks)
    }

    fn exists_sync(&self, path: String) -> Result<bool, ModuleError> {
        files::exists_sync(path)
    }

    fn readdir_sync(&self, path: String, recursive: bool) -> Result<Vec<DirEntry>, ModuleError> {
        dirs::readdir_sync(path, recursive)
    }

    fn mkdir_sync(&self, path: String, recursive: bool, mode: f64) -> Result<bool, ModuleError> {
        dirs::mkdir_sync(path, recursive, mode)
    }

    fn rm_sync(&self, path: String, recursive: bool, force: bool) -> Result<bool, ModuleError> {
        dirs::rm_sync(path, recursive, force)
    }

    fn rename_sync(&self, from: String, to: String) -> Result<bool, ModuleError> {
        files::rename_sync(from, to)
    }

    fn copy_file_sync(&self, from: String, to: String) -> Result<bool, ModuleError> {
        files::copy_file_sync(from, to)
    }

    fn get_paths(&self) -> Result<KnownPaths, ModuleError> {
        paths::known_paths()
    }
}

/// Called by the app's autolink shim, which keeps these modules linked in.
pub fn rn_gpui_register() {
    rn_gpui_module::register(native_fs_module::<RNFsModule>());
}
