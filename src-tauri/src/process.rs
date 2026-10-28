use crate::{err, Result};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}
pub fn spawn(command: &mut Command) -> Result<tokio::process::Child> {
    let mut child = command.spawn().map_err(err)?;
    #[cfg(windows)]
    child_job::attach(&mut child)?;
    Ok(child)
}
// Windows closes the non-inherited job handle when DeskMate exits, including
// forced termination. This also cleans up CLI grandchildren, not just their shell.
#[cfg(windows)]
mod child_job {
    use super::*;
    use std::sync::OnceLock;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{JobObjects::*, Threading::*},
    };
    static JOB: OnceLock<Result<usize>> = OnceLock::new();
    fn handle() -> Result<usize> {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(err(std::io::Error::last_os_error()));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                let error = err(std::io::Error::last_os_error());
                CloseHandle(job);
                return Err(error);
            }
            Ok(job as usize)
        })
        .clone()
    }
    pub fn attach(child: &mut tokio::process::Child) -> Result<()> {
        let job = handle()?;
        let Some(pid) = child.id() else {
            return Ok(());
        };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                if child.try_wait().map_err(err)?.is_some() {
                    return Ok(());
                }
                return Err(err(std::io::Error::last_os_error()));
            }
            let success = AssignProcessToJobObject(job as _, process);
            let error = std::io::Error::last_os_error();
            CloseHandle(process);
            if success == 0 && child.try_wait().map_err(err)?.is_none() {
                return Err(err(error));
            }
        }
        Ok(())
    }
}
async fn read_limit(mut reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let size = reader.read(&mut chunk).await.map_err(err)?;
        if size == 0 {
            return Ok(output);
        }
        if output.len() + size > limit {
            return Err("进程返回数据过大".into());
        }
        output.extend_from_slice(&chunk[..size]);
    }
}
pub async fn output(command: &mut Command, timeout: Duration, limit: usize) -> Result<String> {
    let mut child = spawn(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null()),
    )?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(timeout, async {
        tokio::try_join!(
            read_limit(stdout, limit),
            read_limit(stderr, 1024 * 1024),
            async { child.wait().await.map_err(err) }
        )
    })
    .await;
    match result {
        Ok(Ok((stdout, _stderr, status))) if status.success() => {
            Ok(String::from_utf8_lossy(&stdout).to_string())
        }
        Ok(Ok((_, stderr, _))) => Err(String::from_utf8_lossy(&stderr).chars().take(300).collect()),
        Ok(Err(error)) => {
            let _ = child.kill().await;
            Err(error)
        }
        Err(_) => {
            let _ = child.kill().await;
            Err("操作超时".into())
        }
    }
}
pub fn replace_file(from: &Path, to: &Path) -> Result<()> {
    std::fs::rename(from, to).map_err(err)
}
