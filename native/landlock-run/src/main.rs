//! Pluton native execution helper.
//!
//! `landlock-run` is the only process allowed to create a confined engine
//! session. It applies, in this order:
//!
//! 1. an unprivileged user namespace (uid/gid 0 inside, mapped to the caller);
//! 2. a private mount namespace with private `/tmp` and session tmpfs;
//! 3. a private network namespace (`restricted` / `none`) with loopback only;
//! 4. a PID namespace (the engine is PID 1 of its own namespace);
//! 5. a fresh `/proc`;
//! 6. a Landlock filesystem allowlist (read / execute / write roots);
//! 7. `execve` of the engine with a cleared environment.
//!
//! For `restricted` sessions a trusted proxy process (outside the Landlock
//! domain, inside the network namespace) listens on loopback and forwards to
//! the host-side bridge's AF_UNIX socket. Landlock does not mediate network
//! sockets; network isolation is provided by the network namespace, never by
//! Landlock.
//!
//! The helper fails closed: any setup step that cannot be completed is a
//! startup error (exit 125), never a silent downgrade.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs;
use std::io::{self, ErrorKind};
use std::net::{TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};

const HELPER_ABI: u32 = 1;
const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");
const EXIT_STARTUP: i32 = 125;
const EXIT_EXEC: i32 = 127;
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

// Landlock syscalls have the same numbers on every Linux architecture (they
// were added to the generic syscall table).
const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;

const LANDLOCK_CREATE_RULESET_VERSION: libc::c_uint = 1;
const LANDLOCK_RULE_PATH_BENEATH: libc::c_int = 1;

const ACCESS_FS_EXECUTE: u64 = 1 << 0;
const ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_FS_READ_FILE: u64 = 1 << 2;
const ACCESS_FS_READ_DIR: u64 = 1 << 3;
const ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
const ACCESS_FS_REFER: u64 = 1 << 13;
const ACCESS_FS_TRUNCATE: u64 = 1 << 14;
const ACCESS_FS_IOCTL_DEV: u64 = 1 << 15;

const ACCESS_READ: u64 = ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[derive(Debug, Deserialize)]
struct BridgeSpec {
    unix_path: String,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct Request {
    helper_abi: u32,
    mode: String,
    network: String,
    cwd: String,
    argv: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    read_roots: Vec<String>,
    #[serde(default)]
    write_roots: Vec<String>,
    #[serde(default)]
    exec_roots: Vec<String>,
    tmp_dir: String,
    #[serde(default)]
    private_tmp: bool,
    #[serde(default)]
    bridge: Option<BridgeSpec>,
    #[serde(default)]
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    helper_abi: u32,
    version: &'static str,
    landlock_abi: i32,
    user_namespaces: bool,
    mount_namespaces: bool,
    network_namespaces: bool,
    pid_namespaces: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ready<'a> {
    ready: bool,
    helper_abi: u32,
    version: &'static str,
    session_id: &'a str,
    pid: i32,
    bridge_port: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyError<'a> {
    ready: bool,
    error: &'a str,
}

static CHILD_PID: AtomicI32 = AtomicI32::new(0);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--probe") => {
            let probe = probe();
            print_json(&probe);
        }
        Some("--version") => {
            println!("landlock-run {HELPER_VERSION} (helper ABI {HELPER_ABI})");
        }
        Some("run") => {
            let Some(path) = args.get(2) else {
                eprintln!("landlock-run: run requires a request path");
                std::process::exit(EXIT_STARTUP);
            };
            match run_request(path) {
                Ok(code) => std::process::exit(code),
                Err(err) => {
                    eprintln!("landlock-run: {err}");
                    std::process::exit(EXIT_STARTUP);
                }
            }
        }
        _ => {
            eprintln!(
                "usage: landlock-run --probe | --version | run <request.json>\n\
                 the request run mode needs no arguments beyond the JSON request path"
            );
            std::process::exit(EXIT_STARTUP);
        }
    }
}

fn print_json<T: Serialize>(value: &T) {
    let text = serde_json::to_string(value).expect("serialize probe");
    println!("{text}");
}

fn os_error(what: &str) -> String {
    format!("{what}: {}", io::Error::last_os_error())
}

fn landlock_abi() -> i32 {
    let rc = unsafe {
        libc::syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            ptr::null::<RulesetAttr>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if rc < 0 {
        0
    } else {
        rc as i32
    }
}

fn probe() -> Probe {
    Probe {
        helper_abi: HELPER_ABI,
        version: HELPER_VERSION,
        landlock_abi: landlock_abi(),
        user_namespaces: probe_namespace(libc::CLONE_NEWUSER),
        mount_namespaces: probe_namespace(libc::CLONE_NEWNS),
        network_namespaces: probe_namespace(libc::CLONE_NEWNET),
        pid_namespaces: probe_namespace(libc::CLONE_NEWPID),
    }
}

/// Fork a child and prove that the namespace can actually be created. The
/// helper never reports a capability it has not exercised.
fn probe_namespace(flag: libc::c_int) -> bool {
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return false;
    }
    if pid == 0 {
        let ok = if flag == libc::CLONE_NEWUSER {
            unsafe { libc::unshare(libc::CLONE_NEWUSER) == 0 }
        } else {
            setup_userns().is_ok() && unsafe { libc::unshare(flag) == 0 }
        };
        unsafe { libc::_exit(if ok { 0 } else { 1 }) };
    }
    let mut status = 0;
    loop {
        let rc = unsafe { libc::waitpid(pid, &mut status, 0) };
        if rc == pid {
            break;
        }
        if rc < 0 && io::Error::last_os_error().kind() != ErrorKind::Interrupted {
            return false;
        }
    }
    libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
}

fn load_request(path: &str) -> Result<Request, String> {
    if !Path::new(path).is_absolute() {
        return Err(format!("request path must be absolute: {path}"));
    }
    let meta = fs::metadata(path).map_err(|e| format!("cannot stat request '{path}': {e}"))?;
    if !meta.is_file() {
        return Err(format!("request is not a regular file: {path}"));
    }
    if meta.len() > MAX_REQUEST_BYTES {
        return Err(format!("request exceeds {MAX_REQUEST_BYTES} bytes"));
    }
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read request '{path}': {e}"))?;
    let request: Request =
        serde_json::from_str(&text).map_err(|e| format!("invalid request JSON: {e}"))?;
    Ok(request)
}

fn validate_request(req: &Request) -> Result<(), String> {
    if req.helper_abi != HELPER_ABI {
        return Err(format!(
            "request helper ABI {} is not supported (expected {HELPER_ABI})",
            req.helper_abi
        ));
    }
    if req.mode != "read-only" && req.mode != "workspace-write" {
        return Err(format!("unsupported confinement mode '{}'", req.mode));
    }
    if req.network != "open" && req.network != "restricted" && req.network != "none" {
        return Err(format!("unsupported network policy '{}'", req.network));
    }
    if req.argv.is_empty() {
        return Err("argv must not be empty".into());
    }
    if !Path::new(&req.argv[0]).is_absolute() {
        return Err(format!("argv[0] must be an absolute path: {}", req.argv[0]));
    }
    if !Path::new(&req.cwd).is_absolute() {
        return Err(format!("cwd must be absolute: {}", req.cwd));
    }
    if !Path::new(&req.tmp_dir).is_absolute() {
        return Err(format!("tmp_dir must be absolute: {}", req.tmp_dir));
    }
    for (label, roots) in [
        ("read_roots", &req.read_roots),
        ("write_roots", &req.write_roots),
        ("exec_roots", &req.exec_roots),
    ] {
        for root in roots {
            if !Path::new(root).is_absolute() {
                return Err(format!("{label} entry must be absolute: {root}"));
            }
            if !Path::new(root).exists() {
                return Err(format!("{label} entry does not exist: {root}"));
            }
        }
    }
    if !Path::new(&req.cwd).exists() {
        return Err(format!("cwd does not exist: {}", req.cwd));
    }
    if !Path::new(&req.tmp_dir).exists() {
        return Err(format!("tmp_dir does not exist: {}", req.tmp_dir));
    }
    if req.mode == "read-only" && req.write_roots.iter().any(|r| r != &req.tmp_dir) {
        return Err("read-only requests may only write to the session tmp_dir".into());
    }
    if let Some(bridge) = &req.bridge {
        if !Path::new(&bridge.unix_path).is_absolute() {
            return Err(format!(
                "bridge unix_path must be absolute: {}",
                bridge.unix_path
            ));
        }
        if bridge.port == 0 {
            return Err("bridge port must be non-zero (the host bridge port is reused)".into());
        }
        if req.network == "open" {
            return Err("bridge proxy is only used by restricted network sessions".into());
        }
        if req.network == "none" {
            return Err("network_policy none cannot carry a bridge".into());
        }
    }
    for (key, value) in &req.env {
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(format!("invalid environment key '{key}'"));
        }
        if value.contains('\0') {
            return Err(format!("environment value for '{key}' contains NUL"));
        }
    }
    Ok(())
}

fn run_request(path: &str) -> Result<i32, String> {
    let req = load_request(path)?;
    validate_request(&req)?;
    let abi = landlock_abi();
    if abi < 3 {
        return Err(format!(
            "Landlock ABI 3 or newer is required (this kernel reports {abi})"
        ));
    }

    prepare_namespaces(&req)?;
    if req.network == "restricted" {
        loopback_up()?;
    }

    // Start the bridge proxy BEFORE forking into the new PID namespace. The
    // proxy must stay outside the engine's PID namespace: the engine is PID 1
    // of its own namespace and must not be able to see, signal or ptrace the
    // unconfined proxy process. The proxy shares the user/mount/net namespaces,
    // so loopback and the host bridge socket are reachable.
    let mut proxy = match &req.bridge {
        Some(spec) => match start_proxy(spec) {
            Ok(guard) => Some(guard),
            Err(err) => {
                let _ = write_json_fd3(&ReadyError {
                    ready: false,
                    error: &err,
                });
                return Err(err);
            }
        },
        None => None,
    };

    let (prep_read, prep_write) = pipe_cloexec()?;
    let (go_read, go_write) = pipe_cloexec()?;

    // The child becomes PID 1 of its own PID namespace. The parent keeps the
    // proxy and waits; when the parent dies, PR_SET_PDEATHSIG in the child
    // tears the namespace down.
    if unsafe { libc::unshare(libc::CLONE_NEWPID) } != 0 {
        return Err(os_error("unshare(CLONE_NEWPID)"));
    }
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(os_error("fork"));
    }

    if child == 0 {
        close_fd(prep_read);
        close_fd(go_write);
        match child_setup(&req) {
            Ok(()) => {
                if write_all_fd(prep_write, b"1").is_err() {
                    unsafe { libc::_exit(EXIT_STARTUP) };
                }
                close_fd(prep_write);
                if read_byte(go_read) != Ok(true) {
                    unsafe { libc::_exit(EXIT_STARTUP) };
                }
                close_fd(go_read);
                close_fd(3);
                exec_request(&req)
            }
            Err(err) => {
                let _ = write_json_fd3(&ReadyError {
                    ready: false,
                    error: &err,
                });
                unsafe { libc::_exit(EXIT_STARTUP) };
            }
        }
    }

    close_fd(prep_write);
    close_fd(go_read);
    let prepared = read_byte(prep_read);
    close_fd(prep_read);
    if prepared != Ok(true) {
        reap(child);
        return Err("confined child failed to prepare its sandbox".into());
    }

    let ready = Ready {
        ready: true,
        helper_abi: HELPER_ABI,
        version: HELPER_VERSION,
        session_id: &req.session_id,
        pid: child,
        bridge_port: proxy.as_ref().map(|guard| guard.port),
    };
    if let Err(err) = write_json_fd3(&ready) {
        kill_child(child);
        reap(child);
        return Err(err);
    }
    close_fd(3);
    if let Err(err) = write_all_fd(go_write, b"1") {
        kill_child(child);
        reap(child);
        return Err(err);
    }
    close_fd(go_write);

    CHILD_PID.store(child, Ordering::SeqCst);
    install_signal_handlers();
    let code = wait_child_code(child)?;
    if let Some(mut guard) = proxy.take() {
        guard.stop();
    }
    Ok(code)
}

fn prepare_namespaces(req: &Request) -> Result<(), String> {
    setup_userns()?;

    let mut flags = libc::CLONE_NEWNS;
    if req.network != "open" {
        flags |= libc::CLONE_NEWNET;
    }
    if unsafe { libc::unshare(flags) } != 0 {
        return Err(os_error("unshare(CLONE_NEWNS|CLONE_NEWNET)"));
    }

    let root = CString::new("/").map_err(|e| e.to_string())?;
    let rc = unsafe {
        libc::mount(
            ptr::null(),
            root.as_ptr(),
            ptr::null(),
            (libc::MS_REC | libc::MS_PRIVATE) as libc::c_ulong,
            ptr::null(),
        )
    };
    if rc != 0 {
        return Err(os_error("mount(/, MS_REC|MS_PRIVATE)"));
    }

    if req.private_tmp {
        mount_tmpfs("/tmp", "mode=1777,size=256m")?;
    }
    mount_tmpfs(&req.tmp_dir, "mode=0700,size=256m")?;
    Ok(())
}

fn setup_userns() -> Result<(), String> {
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    if unsafe { libc::unshare(libc::CLONE_NEWUSER) } != 0 {
        return Err(os_error("unshare(CLONE_NEWUSER)"));
    }
    // setgroups may be absent in some container kernels; a failure to deny is
    // only fatal if the gid_map write below also fails.
    let _ = fs::write("/proc/self/setgroups", "deny");
    fs::write("/proc/self/uid_map", format!("0 {uid} 1\n"))
        .map_err(|e| format!("write uid_map: {e}"))?;
    fs::write("/proc/self/gid_map", format!("0 {gid} 1\n"))
        .map_err(|e| format!("write gid_map: {e}"))?;
    if unsafe { libc::setresgid(0, 0, 0) } != 0 {
        return Err(os_error("setresgid(0,0,0)"));
    }
    if unsafe { libc::setresuid(0, 0, 0) } != 0 {
        return Err(os_error("setresuid(0,0,0)"));
    }
    Ok(())
}

fn mount_tmpfs(target: &str, options: &str) -> Result<(), String> {
    let src = CString::new("tmpfs").map_err(|e| e.to_string())?;
    let fstype = CString::new("tmpfs").map_err(|e| e.to_string())?;
    let target_c = CString::new(target).map_err(|e| e.to_string())?;
    let data = CString::new(options).map_err(|e| e.to_string())?;
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            target_c.as_ptr(),
            fstype.as_ptr(),
            (libc::MS_NOSUID | libc::MS_NODEV) as libc::c_ulong,
            data.as_ptr() as *const libc::c_void,
        )
    };
    if rc != 0 {
        return Err(os_error(&format!("mount(tmpfs, {target})")));
    }
    Ok(())
}

fn mount_proc() -> Result<(), String> {
    let src = CString::new("proc").map_err(|e| e.to_string())?;
    let fstype = CString::new("proc").map_err(|e| e.to_string())?;
    let target = CString::new("/proc").map_err(|e| e.to_string())?;
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            (libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC) as libc::c_ulong,
            ptr::null(),
        )
    };
    if rc != 0 {
        return Err(os_error("mount(proc, /proc)"));
    }
    Ok(())
}

fn loopback_up() -> Result<(), String> {
    let sock = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if sock < 0 {
        return Err(os_error("socket(AF_INET)"));
    }
    let mut ifr = [0u8; 40];
    ifr[..2].copy_from_slice(b"lo");
    let rc = unsafe { libc::ioctl(sock, libc::SIOCGIFFLAGS as libc::c_int, ifr.as_mut_ptr()) };
    if rc != 0 {
        close_fd(sock);
        return Err(os_error("ioctl(SIOCGIFFLAGS, lo)"));
    }
    let flags = i16::from_ne_bytes([ifr[16], ifr[17]]) | (libc::IFF_UP as i16) | (libc::IFF_RUNNING as i16);
    ifr[16..18].copy_from_slice(&flags.to_ne_bytes());
    let rc = unsafe { libc::ioctl(sock, libc::SIOCSIFFLAGS as libc::c_int, ifr.as_ptr()) };
    close_fd(sock);
    if rc != 0 {
        return Err(os_error("ioctl(SIOCSIFFLAGS, lo up)"));
    }
    Ok(())
}

fn child_setup(req: &Request) -> Result<(), String> {
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0);
        libc::umask(0o077);
    }
    mount_proc()?;
    apply_landlock(req)
}

fn apply_landlock(req: &Request) -> Result<(), String> {
    let abi = landlock_abi();
    if abi < 1 {
        return Err("Landlock is not available in this kernel".into());
    }
    let handled = handled_rights(abi);
    let attr = RulesetAttr {
        handled_access_fs: handled,
    };
    let ruleset = unsafe {
        libc::syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0usize,
        )
    };
    if ruleset < 0 {
        return Err(os_error("landlock_create_ruleset"));
    }
    let ruleset_fd = ruleset as i32;

    let mut rules: BTreeMap<String, u64> = BTreeMap::new();
    // Structural access the helper guarantees: a fresh /proc and the standard
    // null/entropy devices. Everything else is caller-specified.
    rules.insert("/proc".to_string(), ACCESS_READ);
    for device in ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random", "/dev/tty"] {
        if Path::new(device).exists() {
            let mut access = ACCESS_FS_READ_FILE | ACCESS_FS_WRITE_FILE;
            if abi >= 5 {
                access |= ACCESS_FS_IOCTL_DEV;
            }
            rules.insert(device.to_string(), access);
        }
    }
    for root in &req.read_roots {
        *rules.entry(root.clone()).or_insert(0) |= ACCESS_READ;
    }
    for root in &req.exec_roots {
        *rules
            .entry(root.clone())
            .or_insert(0) |= ACCESS_READ | ACCESS_FS_EXECUTE;
    }
    for root in &req.write_roots {
        *rules.entry(root.clone()).or_insert(0) |= handled;
    }
    // A private tmpfs mounted by prepare_namespaces is useless unless the
    // engine may write to it. It is per-session and vanishes with the mount
    // namespace, so it does not widen the project policy.
    if req.private_tmp {
        *rules.entry("/tmp".to_string()).or_insert(0) |= handled;
    }

    for (path, access) in rules {
        add_path_rule(ruleset_fd, &path, access & handled)?;
    }

    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        close_fd(ruleset_fd);
        return Err(os_error("prctl(PR_SET_NO_NEW_PRIVS)"));
    }
    let rc = unsafe {
        libc::syscall(
            SYS_LANDLOCK_RESTRICT_SELF,
            ruleset_fd as libc::c_long,
            0usize,
        )
    };
    close_fd(ruleset_fd);
    if rc != 0 {
        return Err(os_error("landlock_restrict_self"));
    }
    Ok(())
}

fn add_path_rule(ruleset_fd: i32, path: &str, access: u64) -> Result<(), String> {
    let path_c = CString::new(path).map_err(|e| e.to_string())?;
    let fd = unsafe { libc::open(path_c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(os_error(&format!("open({path}, O_PATH)")));
    }
    let rule = PathBeneathAttr {
        allowed_access: access,
        parent_fd: fd,
    };
    let rc = unsafe {
        libc::syscall(
            SYS_LANDLOCK_ADD_RULE,
            ruleset_fd as libc::c_long,
            LANDLOCK_RULE_PATH_BENEATH as libc::c_long,
            &rule as *const PathBeneathAttr,
            0usize,
        )
    };
    close_fd(fd);
    if rc != 0 {
        return Err(os_error(&format!("landlock_add_rule({path})")));
    }
    Ok(())
}

fn handled_rights(abi: i32) -> u64 {
    let mut rights = ACCESS_FS_EXECUTE
        | ACCESS_FS_WRITE_FILE
        | ACCESS_FS_READ_FILE
        | ACCESS_FS_READ_DIR
        | ACCESS_FS_REMOVE_DIR
        | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_CHAR
        | ACCESS_FS_MAKE_DIR
        | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK
        | ACCESS_FS_MAKE_FIFO
        | ACCESS_FS_MAKE_BLOCK
        | ACCESS_FS_MAKE_SYM;
    if abi >= 2 {
        rights |= ACCESS_FS_REFER;
    }
    if abi >= 3 {
        rights |= ACCESS_FS_TRUNCATE;
    }
    if abi >= 5 {
        rights |= ACCESS_FS_IOCTL_DEV;
    }
    rights
}

fn exec_request(req: &Request) -> ! {
    let mut command = Command::new(&req.argv[0]);
    command
        .args(&req.argv[1..])
        .env_clear()
        .envs(req.env.iter())
        .current_dir(&req.cwd);
    let err = command.exec();
    eprintln!("landlock-run: exec {} failed: {err}", req.argv[0]);
    unsafe { libc::_exit(EXIT_EXEC) }
}

/**
 * A forked loopback proxy for one restricted-network session.
 *
 * Why a process instead of a thread: thread creation inside a fresh user
 * namespace can fail with EAGAIN on memory-constrained hosts, and a process
 * gives the proxy an independent lifetime/signal boundary. Each accepted TCP
 * connection is forwarded by its own forked handler, so a slow bridge client
 * can never stall the accept loop or another session.
 */
struct ProxyGuard {
    pid: i32,
    port: u16,
}

impl ProxyGuard {
    fn stop(&mut self) {
        if self.pid > 0 {
            stop_proxy(self.pid);
            self.pid = 0;
        }
    }
}

impl Drop for ProxyGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start_proxy(spec: &BridgeSpec) -> Result<ProxyGuard, String> {
    let (status_read, status_write) = pipe_cloexec()?;
    let unix_path = spec.unix_path.clone();
    let port = spec.port;
    let helper_pid = unsafe { libc::getpid() };
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        close_fd(status_read);
        close_fd(status_write);
        return Err(os_error("fork bridge proxy"));
    }
    if pid == 0 {
        close_fd(status_read);
        // The readiness pipe belongs to the helper/engine contract; the proxy
        // must never hold it open or an exited helper would look alive to the
        // provider.
        close_fd(3);
        unsafe {
            libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0,
                0,
                0,
            );
        }
        if unsafe { libc::getppid() } != helper_pid {
            let message = format!(
                "ERR proxy parent changed before startup (ppid {} != {helper_pid})\n",
                unsafe { libc::getppid() }
            );
            let _ = write_all_fd(status_write, message.as_bytes());
            unsafe { libc::_exit(EXIT_STARTUP) };
        }
        // Handler processes are reaped automatically; the proxy itself runs
        // until it is killed or its parent dies.
        unsafe {
            libc::signal(libc::SIGCHLD, libc::SIG_IGN);
        }
        // proxy_serve only returns on a startup failure; on success it never
        // returns, so reaching the exit below is always an error.
        let _ = proxy_serve(port, &unix_path, status_write);
        unsafe { libc::_exit(EXIT_STARTUP) }
    }

    close_fd(status_write);
    let message = match read_line_fd(status_read) {
        Ok(line) => line,
        Err(err) => {
            close_fd(status_read);
            kill_child(pid);
            reap(pid);
            return Err(err);
        }
    };
    close_fd(status_read);
    if let Some(rest) = message.strip_prefix("PORT ") {
        let bound = rest
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("invalid proxy port '{rest}'"))?;
        if bound == 0 {
            kill_child(pid);
            reap(pid);
            return Err("bridge proxy reported port 0".into());
        }
        Ok(ProxyGuard { pid, port: bound })
    } else {
        kill_child(pid);
        reap(pid);
        let detail = message.strip_prefix("ERR ").unwrap_or(&message);
        Err(format!("bridge proxy failed to start: {detail}"))
    }
}

/// Runs inside the forked proxy. Binds loopback, reports the bound port on the
/// status pipe, then accepts and forks one forwarding handler per connection.
fn proxy_serve(port: u16, unix_path: &str, status_fd: i32) -> Result<(), String> {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(err) => {
            let message = format!("ERR bind 127.0.0.1:{port}: {err}\n");
            let _ = write_all_fd(status_fd, message.as_bytes());
            close_fd(status_fd);
            return Err(format!("bind 127.0.0.1:{port}: {err}"));
        }
    };
    let bound = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(err) => {
            let message = format!("ERR read proxy address: {err}\n");
            let _ = write_all_fd(status_fd, message.as_bytes());
            close_fd(status_fd);
            return Err(format!("read proxy address: {err}"));
        }
    };
    let ready = format!("PORT {bound}\n");
    if let Err(err) = write_all_fd(status_fd, ready.as_bytes()) {
        close_fd(status_fd);
        return Err(format!("write proxy readiness: {err}"));
    }
    close_fd(status_fd);

    let proxy_pid = unsafe { libc::getpid() };
    loop {
        let (stream, _) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) => {
                eprintln!("landlock-run: bridge proxy accept failed: {err}");
                return Err(format!("bridge proxy accept failed: {err}"));
            }
        };
        let path = unix_path.to_string();
        let child = unsafe { libc::fork() };
        if child < 0 {
            eprintln!(
                "landlock-run: bridge proxy fork failed: {}",
                io::Error::last_os_error()
            );
            drop(stream);
            continue;
        }
        if child == 0 {
            unsafe {
                libc::prctl(
                    libc::PR_SET_PDEATHSIG,
                    libc::SIGKILL as libc::c_ulong,
                    0,
                    0,
                    0,
                );
            }
            if unsafe { libc::getppid() } != proxy_pid {
                unsafe { libc::_exit(1) };
            }
            // The handler must not keep the listening socket alive.
            drop(listener);
            let _ = proxy_one(stream, &path);
            unsafe { libc::_exit(0) };
        }
        // The proxy process keeps only the listening socket.
        drop(stream);
    }
}

fn proxy_one(tcp: TcpStream, unix_path: &str) -> io::Result<()> {
    let unix = UnixStream::connect(unix_path)?;
    let _ = tcp.set_nodelay(true);
    forward_bidirectional(tcp, unix);
    Ok(())
}

/// Full-duplex forwarding with `poll` and half-close propagation. `poll` is
/// async-signal-safe and avoids the two-thread design that previously failed
/// with EAGAIN inside the user namespace.
fn forward_bidirectional(tcp: TcpStream, unix: UnixStream) {
    let tcp_fd = tcp.as_raw_fd();
    let unix_fd = unix.as_raw_fd();
    let mut tcp_open = true;
    let mut unix_open = true;
    let mut buf = [0u8; 16 * 1024];

    while tcp_open || unix_open {
        let mut fds = [
            libc::pollfd {
                fd: if tcp_open { tcp_fd } else { -1 },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if unix_open { unix_fd } else { -1 },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let rc = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if rc == 0 {
            continue;
        }

        if tcp_open && fds[0].revents != 0 {
            match read_fd(tcp_fd, &mut buf) {
                Ok(0) | Err(_) => {
                    tcp_open = false;
                    shutdown_fd(unix_fd, libc::SHUT_WR);
                }
                Ok(n) => {
                    if write_all_fd(unix_fd, &buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        if unix_open && fds[1].revents != 0 {
            match read_fd(unix_fd, &mut buf) {
                Ok(0) | Err(_) => {
                    unix_open = false;
                    shutdown_fd(tcp_fd, libc::SHUT_WR);
                }
                Ok(n) => {
                    if write_all_fd(tcp_fd, &buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    }
}

fn read_fd(fd: i32, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        return Ok(n as usize);
    }
}

fn shutdown_fd(fd: i32, how: libc::c_int) {
    unsafe {
        libc::shutdown(fd, how);
    }
}

fn read_line_fd(fd: i32) -> Result<String, String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = unsafe { libc::read(fd, byte.as_mut_ptr() as *mut libc::c_void, 1) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("read bridge proxy status: {err}"));
        }
        if n == 0 {
            return Err("bridge proxy exited before reporting readiness".into());
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
        if line.len() > 512 {
            return Err("bridge proxy status line is too long".into());
        }
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

fn stop_proxy(pid: i32) {
    // SIGKILL: the proxy holds no state that needs flushing, and handler
    // processes inherit PR_SET_PDEATHSIG so they cannot outlive it.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    reap(pid);
}

fn pipe_cloexec() -> Result<(i32, i32), String> {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(os_error("pipe2"));
    }
    Ok((fds[0], fds[1]))
}

fn write_all_fd(fd: i32, mut buf: &[u8]) -> Result<(), String> {
    while !buf.is_empty() {
        let written = unsafe { libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
        if written < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("write fd {fd}: {err}"));
        }
        if written == 0 {
            return Err(format!("write fd {fd}: zero-length write"));
        }
        buf = &buf[written as usize..];
    }
    Ok(())
}

fn read_byte(fd: i32) -> Result<bool, String> {
    let mut byte = [0u8; 1];
    loop {
        let read = unsafe { libc::read(fd, byte.as_mut_ptr() as *mut libc::c_void, 1) };
        if read < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("read fd {fd}: {err}"));
        }
        if read == 0 {
            return Ok(false);
        }
        return Ok(true);
    }
}

fn fd_is_open(fd: i32) -> bool {
    unsafe { libc::fcntl(fd, libc::F_GETFD) >= 0 }
}

fn write_json_fd3<T: Serialize>(value: &T) -> Result<(), String> {
    if !fd_is_open(3) {
        return Ok(());
    }
    let mut line = serde_json::to_vec(value).map_err(|e| format!("serialize ready message: {e}"))?;
    line.push(b'\n');
    write_all_fd(3, &line)
}

fn close_fd(fd: i32) {
    if fd >= 0 {
        unsafe {
            libc::close(fd);
        }
    }
}

fn kill_child(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

fn reap(pid: i32) {
    let mut status = 0;
    loop {
        let rc = unsafe { libc::waitpid(pid, &mut status, 0) };
        if rc == pid || (rc < 0 && io::Error::last_os_error().kind() != ErrorKind::Interrupted) {
            break;
        }
    }
}

extern "C" fn forward_signal(sig: libc::c_int) {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

fn install_signal_handlers() {
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT] {
        unsafe {
            libc::signal(sig, forward_signal as *const () as usize);
        }
    }
}

fn wait_child_code(child: i32) -> Result<i32, String> {
    let mut status = 0;
    loop {
        let rc = unsafe { libc::waitpid(child, &mut status, 0) };
        if rc == child {
            break;
        }
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("waitpid: {err}"));
        }
    }
    if libc::WIFEXITED(status) {
        return Ok(libc::WEXITSTATUS(status));
    }
    if libc::WIFSIGNALED(status) {
        return Ok(128 + libc::WTERMSIG(status));
    }
    Ok(EXIT_STARTUP)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        Request {
            helper_abi: HELPER_ABI,
            mode: "workspace-write".into(),
            network: "restricted".into(),
            cwd: "/tmp".into(),
            argv: vec!["/bin/true".into()],
            env: BTreeMap::new(),
            read_roots: vec![],
            write_roots: vec!["/tmp".into()],
            exec_roots: vec![],
            tmp_dir: "/tmp".into(),
            private_tmp: false,
            bridge: None,
            session_id: "s".into(),
        }
    }

    #[test]
    fn accepts_a_minimal_workspace_request() {
        let mut req = request();
        req.tmp_dir = "/tmp".into();
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn rejects_relative_exec() {
        let mut req = request();
        req.argv = vec!["bin/true".into()];
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn rejects_read_only_writes_outside_tmp() {
        let mut req = request();
        req.mode = "read-only".into();
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn bridge_is_rejected_with_network_none() {
        let mut req = request();
        req.network = "none".into();
        req.bridge = Some(BridgeSpec {
            unix_path: "/tmp/bridge.sock".into(),
            port: 1234,
        });
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn handled_rights_follow_the_landlock_abi() {
        assert_eq!(handled_rights(1) & ACCESS_FS_REFER, 0);
        assert_ne!(handled_rights(2) & ACCESS_FS_REFER, 0);
        assert_eq!(handled_rights(2) & ACCESS_FS_TRUNCATE, 0);
        assert_ne!(handled_rights(3) & ACCESS_FS_TRUNCATE, 0);
        assert_eq!(handled_rights(4) & ACCESS_FS_IOCTL_DEV, 0);
        assert_ne!(handled_rights(5) & ACCESS_FS_IOCTL_DEV, 0);
    }
}
