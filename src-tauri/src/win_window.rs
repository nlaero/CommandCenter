//! Taskbar click on a minimized Command Center window.
//!
//! The main window is not hidden, not skipped on the taskbar, and close is not
//! turned into hide. On Windows, clicking that taskbar button activates a
//! minimized WebView2 window without a plain `SC_RESTORE`, so the same window
//! stays iconic. Post the plain restore command, which unminimizes and focuses it.

#![cfg_attr(not(any(windows, test)), allow(dead_code))]

pub const WM_ACTIVATE: u32 = 0x0006;
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
        if restoring {
            RESTORING.store(false, Ordering::SeqCst);
        }
        result
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
}
