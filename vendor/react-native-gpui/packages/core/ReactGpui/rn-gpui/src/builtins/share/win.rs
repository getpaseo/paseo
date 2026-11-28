//! The Windows share UI, opened with `IDataTransferManagerInterop`.

use std::cell::RefCell;
use windows::{
    core::{factory, Ref, HSTRING},
    ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager},
    Foundation::{TypedEventHandler, Uri},
    Win32::{Foundation::HWND, UI::Shell::IDataTransferManagerInterop},
};

thread_local! {
    /// The handler of the previous share, which is removed before the next one is
    /// added: a manager keeps every handler it is given.
    static PREVIOUS: RefCell<Option<(DataTransferManager, i64)>> = const { RefCell::new(None) };
}

/// Opens the share UI for `hwnd`. `requested` is called when Windows asks for the
/// content, which is when the user has chosen a target. Fails when the UI cannot
/// be shown or there is nothing to share.
pub fn present(
    hwnd: isize,
    title: &str,
    message: Option<&str>,
    url: Option<&str>,
    requested: impl Fn() + Send + 'static,
) -> windows::core::Result<()> {
    if message.is_none() && url.is_none() {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x8007_0057_u32 as i32,
        )));
    }
    let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
    // SAFETY: `hwnd` is the live handle of a window owned by this thread.
    let manager: DataTransferManager = unsafe { interop.GetForWindow(HWND(hwnd as _))? };
    PREVIOUS.with(|previous| {
        if let Some((old, token)) = previous.borrow_mut().take() {
            let _ = old.RemoveDataRequested(token);
        }
    });
    let title = HSTRING::from(title);
    let message = message.map(HSTRING::from);
    let url = url.map(HSTRING::from);
    let token = manager.DataRequested(&TypedEventHandler::new(
        move |_: Ref<'_, DataTransferManager>, args: Ref<'_, DataRequestedEventArgs>| {
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            let data = args.Request()?.Data()?;
            data.Properties()?.SetTitle(&title)?;
            if let Some(message) = &message {
                data.SetText(message)?;
            }
            if let Some(url) = &url {
                data.SetWebLink(&Uri::CreateUri(url)?)?;
            }
            requested();
            Ok(())
        },
    ))?;
    PREVIOUS.with(|previous| *previous.borrow_mut() = Some((manager, token)));
    // SAFETY: the same window handle, on the thread that owns it.
    unsafe { interop.ShowShareUIForWindow(HWND(hwnd as _)) }
}
