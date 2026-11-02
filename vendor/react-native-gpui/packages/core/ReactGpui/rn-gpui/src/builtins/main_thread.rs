use futures::channel::oneshot;
use gpui::App;
use rn_gpui_module::ModuleError;

pub(crate) async fn on_main<T: Send + 'static>(
    command: impl FnOnce(&mut App) -> T + Send + 'static,
) -> Result<T, ModuleError> {
    let (sender, receiver) = oneshot::channel();
    crate::desktop::post_to_main(Box::new(move |cx| {
        let _ = sender.send(command(cx));
    }));
    receiver
        .await
        .map_err(|_| ModuleError::new("the desktop shell is not running"))
}
