//! Child processes started by the desktop app.
//!
//! The installed build is a Windows GUI program (`windows_subsystem = "windows"`).
//! A console-subsystem child such as whisper-cli, ffmpeg, tar, or cmd then gets
//! its own console. A board that starts captions or listening on load used to
//! open one of those per panel, on the UI thread, and the window stopped
//! taking input — including a click on its taskbar button.

use std::ffi::OsStr;
use std::process::Command;
use std::sync::Mutex;

/// `CREATE_NO_WINDOW`. Not combined with `DETACHED_PROCESS`: callers wait on the pipes.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `DETACHED_PROCESS`. Only for the long-running auth-server, which must outlive this window.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub const DETACHED_PROCESS: u32 = 0x0000_0008;

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn no_console_flags() -> u32 {
    CREATE_NO_WINDOW
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn background_flags() -> u32 {
    CREATE_NO_WINDOW | DETACHED_PROCESS
}

pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    hide_console(&mut cmd);
    cmd
}

pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_console_flags());
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// One ffmpeg or whisper at a time. Parallel copies on load peg the machine.
pub fn one_at_a_time<T>(job: impl FnOnce() -> T) -> T {
    static GATE: Mutex<()> = Mutex::new(());
    let _hold = GATE.lock().unwrap_or_else(|err| err.into_inner());
    job()
}

pub fn stop_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        let _ = command("kill").args(["-9", &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        let _ = command("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn caption_tools_hide_the_console_without_detaching() {
        let flags = no_console_flags();
        assert_eq!(flags & CREATE_NO_WINDOW, CREATE_NO_WINDOW);
        assert_eq!(
            flags & DETACHED_PROCESS,
            0,
            "detaching drops the pipes caption jobs read"
        );
    }

    #[test]
    fn background_server_hides_its_console_and_detaches() {
        let flags = background_flags();
        assert_eq!(flags & CREATE_NO_WINDOW, CREATE_NO_WINDOW);
        assert_eq!(flags & DETACHED_PROCESS, DETACHED_PROCESS);
    }

    #[test]
    fn one_local_tool_runs_at_a_time() {
        static DEPTH: AtomicUsize = AtomicUsize::new(0);
        static MAX: AtomicUsize = AtomicUsize::new(0);
        let mut handles = Vec::new();
        for _ in 0..4 {
            handles.push(thread::spawn(|| {
                one_at_a_time(|| {
                    let depth = DEPTH.fetch_add(1, Ordering::SeqCst) + 1;
                    MAX.fetch_max(depth, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(40));
                    DEPTH.fetch_sub(1, Ordering::SeqCst);
                });
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(MAX.load(Ordering::SeqCst), 1);
        assert_eq!(DEPTH.load(Ordering::SeqCst), 0);
    }
}
