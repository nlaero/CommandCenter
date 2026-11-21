//! Taskbar click on a minimized Command Center window.
//!
//! The main window is not hidden, not skipped on the taskbar, and close is not
//! turned into hide. On Windows, clicking that taskbar button activates a
//! minimized WebView2 window without a plain `SC_RESTORE`, so the same window
//! stays iconic. Post the plain restore command, which unminimizes and focuses it.

#![cfg_attr(not(any(windows, test)), allow(dead_code))]

pub const WM_ACTIVATE: u32 = 0x0006;
pub const WM_GETMINMAXINFO: u32 = 0x0024;
pub const WM_SYSCOMMAND: u32 = 0x0112;
pub const WA_INACTIVE: u32 = 0;
/// Plain restore. tao clears its minimized flag only on this exact value.
pub const SC_RESTORE: u32 = 0xF120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskbarAction {
    /// Activation while minimized. Post a plain `SC_RESTORE` for this window.
    PostRestore,
    /// Plain `SC_RESTORE` while the window is still iconic. Show it, then continue.
    ForceRestore,
    Pass,
}

pub fn taskbar_action(msg: u32, wparam: usize, iconic: bool) -> TaskbarAction {
    if msg == WM_SYSCOMMAND {
        let cmd = (wparam & 0xFFF0) as u32;
        let exact = wparam as u32 == SC_RESTORE;
        if iconic && exact {
            return TaskbarAction::ForceRestore;
        }
        // The shell sometimes sets the low 4 bits. tao then leaves its
        // minimized flag set, so ask again with the plain value.
        if iconic && cmd == SC_RESTORE {
            return TaskbarAction::PostRestore;
        }
    }
    if msg == WM_ACTIVATE {
        let low = (wparam & 0xFFFF) as u32;
        let minimized_bit = (wparam >> 16) != 0;
        if low != WA_INACTIVE && (iconic || minimized_bit) {
            return TaskbarAction::PostRestore;
        }
    }
    TaskbarAction::Pass
}

/// A monitor rectangle in physical pixels. `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Maximized or full-screen origin and size. Origin is relative to the
/// monitor's top-left, which is what `WM_GETMINMAXINFO` expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorFit {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Maximized window: the work area of the monitor the window is on.
/// The full monitor rectangle continues behind and below the taskbar.
pub fn maximized_bounds(monitor: ScreenRect, work: ScreenRect) -> MonitorFit {
    MonitorFit {
        x: work.left - monitor.left,
        y: work.top - monitor.top,
        width: work.right - work.left,
        height: work.bottom - work.top,
    }
}

/// Full screen covers the monitor the window is already on, taskbar included.
pub fn fullscreen_monitor_bounds(monitor: ScreenRect) -> MonitorFit {
    MonitorFit {
        x: 0,
        y: 0,
        width: monitor.right - monitor.left,
        height: monitor.bottom - monitor.top,
    }
}

/// `None` when the window is already in the requested mode, so a second
/// Full screen does not replace the window we will restore.
pub fn fullscreen_change(active: bool, on: bool) -> Option<bool> {
    if active == on { None } else { Some(on) }
}

static DATA_FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn data_fullscreen() -> bool {
    DATA_FULLSCREEN.load(std::sync::atomic::Ordering::SeqCst)
}

/// Borderless full screen on every window, each on the display it is already on.
/// Turning it off restores the placement tao saved, including a maximized window.
pub fn set_data_fullscreen(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    // One transition at a time, on the window thread, so saving the previous
    // window cannot race with restoring it.
    app.run_on_main_thread(move || {
        let _ = tx.send(apply_data_fullscreen(&app, on));
    })
    .map_err(|err| format!("Could not change full screen: {err}"))?;
    rx.recv()
        .map_err(|_| "Could not change full screen.".to_string())?
}

fn apply_data_fullscreen(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    if fullscreen_change(data_fullscreen(), on).is_none() {
        return Ok(());
    }
    // Set this before the windows move. Leaving full screen re-maximizes through
    // WM_GETMINMAXINFO, which must already be using the work area.
    DATA_FULLSCREEN.store(on, std::sync::atomic::Ordering::SeqCst);
    let mut first_error: Option<String> = None;
    for window in app.webview_windows().into_values() {
        if let Err(err) = window.set_fullscreen(on) {
            if first_error.is_none() {
                first_error = Some(format!("Could not change full screen: {err}"));
            }
        }
    }
    // Hide the menu after the previous placement is saved, and show it again
    // after that placement is restored.
    if on {
        hide_window_menus(app);
    } else {
        restore_main_menu(app);
    }
    if let Err(err) = tauri::Emitter::emit(app, "data-fullscreen", on) {
        if first_error.is_none() {
            first_error = Some(format!("Could not change full screen: {err}"));
        }
    }
    match first_error {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// A window created while full screen covers the display it was opened on.
pub fn cover_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if !data_fullscreen() {
        return;
    }
    let _ = window.set_fullscreen(true);
    if window.is_menu_visible().unwrap_or(false) {
        let _ = window.hide_menu();
    }
}

fn hide_window_menus(app: &tauri::AppHandle) {
    for window in app.webview_windows().into_values() {
        if window.is_menu_visible().unwrap_or(false) {
            let _ = window.hide_menu();
        }
    }
}

fn restore_main_menu(app: &tauri::AppHandle) {
    for window in app.webview_windows().into_values() {
        if window.menu().is_some() {
            let _ = window.show_menu();
        }
    }
}

pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    install_windows(window);
    #[cfg(not(windows))]
    {
        let _ = window;
    }
}

#[cfg(windows)]
fn install_windows<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    // AddTab, not a hide. Close stays the real close.
    let _ = window.set_skip_taskbar(false);
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let _ = windows::Win32::UI::Shell::SetWindowSubclass(
            hwnd,
            Some(taskbar_subclass),
            SUBCLASS_ID,
            0,
        );
    }
}

#[cfg(windows)]
const SUBCLASS_ID: usize = 0x4343_5452;

#[cfg(windows)]
static RESTORING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
unsafe extern "system" fn taskbar_subclass(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::WPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
    use windows::Win32::UI::{Shell::DefSubclassProc, WindowsAndMessaging::PostMessageW};

    unsafe {
        use std::sync::atomic::Ordering;
        let iconic = windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd).as_bool();
        let action = taskbar_action(msg, wparam.0, iconic);
        let restoring = matches!(
            action,
            TaskbarAction::PostRestore | TaskbarAction::ForceRestore
        ) && !RESTORING.swap(true, Ordering::SeqCst);
        if restoring {
            // SW_RESTORE unminimizes and activates this same HWND. The plain
            // SC_RESTORE is what tao needs to drop its minimized flag; the shell
            // often sets the low 4 bits, which tao's exact compare misses.
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
            if action == TaskbarAction::PostRestore {
                let _ = PostMessageW(
                    Some(hwnd),
                    WM_SYSCOMMAND,
                    WPARAM(SC_RESTORE as usize),
                    windows::Win32::Foundation::LPARAM(0),
                );
            }
        }
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        // tao answers this message without calling DefWindowProc and without
        // setting the maximized size, so Windows keeps the full monitor
        // rectangle. Fill the work area after that so our size wins.
        if msg == WM_GETMINMAXINFO {
            fit_maximized_window(hwnd, lparam);
        }
        if restoring {
            RESTORING.store(false, Ordering::SeqCst);
        }
        result
    }
}

#[cfg(windows)]
fn fit_maximized_window(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) {
    if lparam.0 == 0 {
        return;
    }
    let Some((monitor, work)) = monitor_rects(hwnd) else {
        return;
    };
    let bounds = if data_fullscreen() {
        fullscreen_monitor_bounds(monitor)
    } else {
        maximized_bounds(monitor, work)
    };
    unsafe {
        let info = &mut *(lparam.0 as *mut windows::Win32::UI::WindowsAndMessaging::MINMAXINFO);
        info.ptMaxPosition.x = bounds.x;
        info.ptMaxPosition.y = bounds.y;
        info.ptMaxSize.x = bounds.width;
        info.ptMaxSize.y = bounds.height;
    }
}

#[cfg(windows)]
fn monitor_rects(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<(ScreenRect, ScreenRect)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let empty = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            rcMonitor: empty,
            rcWork: empty,
            dwFlags: 0,
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        Some((rect_from(info.rcMonitor), rect_from(info.rcWork)))
    }
}

#[cfg(windows)]
fn rect_from(rect: windows::Win32::Foundation::RECT) -> ScreenRect {
    ScreenRect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskbar_activation_of_a_minimized_window_restores_that_window() {
        let active = WA_INACTIVE + 1;
        assert_eq!(
            taskbar_action(WM_ACTIVATE, active as usize, true),
            TaskbarAction::PostRestore
        );
        let click_active = (1u32 << 16) | 2;
        assert_eq!(
            taskbar_action(WM_ACTIVATE, click_active as usize, false),
            TaskbarAction::PostRestore
        );
    }

    #[test]
    fn plain_restore_shows_the_iconic_window() {
        assert_eq!(
            taskbar_action(WM_SYSCOMMAND, SC_RESTORE as usize, true),
            TaskbarAction::ForceRestore
        );
    }

    #[test]
    fn inexact_restore_is_replayed_as_the_plain_command() {
        let with_low_bits = (SC_RESTORE | 0x2) as usize;
        assert_eq!(
            taskbar_action(WM_SYSCOMMAND, with_low_bits, true),
            TaskbarAction::PostRestore
        );
        assert_eq!((with_low_bits & 0xFFF0) as u32, SC_RESTORE);
    }

    #[test]
    fn deactivate_and_visible_focus_do_not_restore() {
        assert_eq!(
            taskbar_action(WM_ACTIVATE, WA_INACTIVE as usize, true),
            TaskbarAction::Pass
        );
        assert_eq!(taskbar_action(WM_ACTIVATE, 1, false), TaskbarAction::Pass);
        assert_eq!(
            taskbar_action(WM_SYSCOMMAND, SC_RESTORE as usize, false),
            TaskbarAction::Pass
        );
        assert_eq!(
            taskbar_action(WM_SYSCOMMAND, 0xF020, true),
            TaskbarAction::Pass,
            "minimize must not be turned into a restore"
        );
    }

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> ScreenRect {
        ScreenRect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn maximized_window_ends_at_the_taskbar() {
        let monitor = rect(0, 0, 1920, 1080);
        let work = rect(0, 0, 1920, 1040);
        let fit = maximized_bounds(monitor, work);
        assert_eq!(
            fit,
            MonitorFit {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040
            }
        );
        assert_ne!(fit.height, 1080, "the full monitor continues under the taskbar");
    }

    #[test]
    fn maximized_window_follows_a_taskbar_on_any_edge() {
        let monitor = rect(0, 0, 1920, 1080);
        assert_eq!(
            maximized_bounds(monitor, rect(0, 48, 1920, 1080)),
            MonitorFit {
                x: 0,
                y: 48,
                width: 1920,
                height: 1032
            }
        );
        assert_eq!(
            maximized_bounds(monitor, rect(62, 0, 1920, 1080)),
            MonitorFit {
                x: 62,
                y: 0,
                width: 1858,
                height: 1080
            }
        );
        assert_eq!(
            maximized_bounds(monitor, rect(0, 0, 1860, 1080)),
            MonitorFit {
                x: 0,
                y: 0,
                width: 1860,
                height: 1080
            }
        );
    }

    #[test]
    fn maximized_window_uses_the_display_it_is_on() {
        let monitor = rect(1920, 0, 4480, 1440);
        let work = rect(1920, 0, 4480, 1400);
        assert_eq!(
            maximized_bounds(monitor, work),
            MonitorFit {
                x: 0,
                y: 0,
                width: 2560,
                height: 1400
            }
        );
        let left = rect(-1920, 0, 0, 1080);
        assert_eq!(
            maximized_bounds(left, rect(-1920, 0, 0, 1032)),
            MonitorFit {
                x: 0,
                y: 0,
                width: 1920,
                height: 1032
            }
        );
    }

    #[test]
    fn fullscreen_covers_the_monitor_the_window_is_on() {
        let monitor = rect(1920, 0, 4480, 1440);
        let work = rect(1920, 0, 4480, 1400);
        assert_eq!(
            fullscreen_monitor_bounds(monitor),
            MonitorFit {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440
            }
        );
        assert_ne!(
            fullscreen_monitor_bounds(monitor),
            maximized_bounds(monitor, work)
        );
    }

    #[test]
    fn a_second_fullscreen_does_not_replace_the_saved_window() {
        assert_eq!(fullscreen_change(false, true), Some(true));
        assert_eq!(fullscreen_change(true, true), None);
        assert_eq!(fullscreen_change(true, false), Some(false));
        assert_eq!(fullscreen_change(false, false), None);
    }
}
