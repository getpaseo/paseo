use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::thread::JoinHandle;

use futures::channel::mpsc;
use futures::executor::LocalPool;
use futures::task::LocalSpawnExt;
use futures::StreamExt;

pub type LocalBoxFuture<T> = Pin<Box<dyn Future<Output = T> + 'static>>;

/// A job is built on the calling thread and turned into a future on the thread
/// that polls it, so the future itself never crosses threads.
pub type Job = Box<dyn FnOnce() -> LocalBoxFuture<()> + Send + 'static>;

/// A serial executor for one module: one thread and one `LocalPool`, so a job
/// that awaits does not hold up the next job.
pub struct ModuleQueue {
    sender: Option<mpsc::UnboundedSender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl ModuleQueue {
    pub fn new(name: &str) -> Self {
        let (sender, mut receiver) = mpsc::unbounded::<Job>();
        let thread = std::thread::Builder::new()
            .name(format!("rn.module.{name}"))
            .spawn(move || {
                let mut pool = LocalPool::new();
                let spawner = pool.spawner();
                pool.run_until(async move {
                    while let Some(job) = receiver.next().await {
                        let _ = spawner.spawn_local(job());
                    }
                });
            })
            .expect("spawn a module thread");
        Self {
            sender: Some(sender),
            thread: Some(thread),
        }
    }

    pub fn post(&self, job: Job) {
        if let Some(sender) = &self.sender {
            // The receiver only goes away when the queue is dropped, and
            // `post` cannot outlive it.
            let _ = sender.unbounded_send(job);
        }
    }
}

impl Drop for ModuleQueue {
    fn drop(&mut self) {
        // Closing the channel ends `run_until`, which drops unfinished futures.
        self.sender = None;
        let Some(thread) = self.thread.take() else {
            return;
        };
        if thread.thread().id() == std::thread::current().id() {
            // A job dropped the queue that owns this thread; joining would
            // deadlock on itself.
            return;
        }
        let _ = thread.join();
    }
}

static MAIN_THREAD: OnceLock<std::thread::ThreadId> = OnceLock::new();

/// Records the calling thread as the GPUI main thread. The host calls this when
/// the main loop starts.
pub fn note_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

pub fn is_main_thread() -> bool {
    MAIN_THREAD
        .get()
        .is_some_and(|id| *id == std::thread::current().id())
}

static MAIN_SPAWNER: OnceLock<Box<dyn Fn(Job) + Send + Sync>> = OnceLock::new();

/// Installed once by the host so `ModuleThread::Main` jobs reach the main
/// thread.
pub fn set_main_spawner(spawn: impl Fn(Job) + Send + Sync + 'static) {
    let _ = MAIN_SPAWNER.set(Box::new(spawn));
}

/// Runs `job` on the main thread, or drops it when no spawner is installed.
pub fn spawn_main(job: Job) {
    match MAIN_SPAWNER.get() {
        Some(spawn) => spawn(job),
        None => {
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| {
                eprintln!(
                    "rn_gpui_module::spawn_main: no main-thread spawner installed; job dropped"
                );
            });
        }
    }
}
