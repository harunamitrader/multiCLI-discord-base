use std::{
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent, Url};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const HEALTH_PATH: &str = "/api/health";
const HEALTH_OK_MARKER: &str = "\"ok\":true";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct BridgeProcessState {
    child: Mutex<Option<Child>>,
}

#[derive(Clone)]
struct BridgeTarget {
    host: String,
    port: u16,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BridgeProcessState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::Ready => {
                let handle = app_handle.clone();
                thread::spawn(move || {
                    log_wrapper(&handle, "startup worker: begin");
                    match initialize_main_window(&handle) {
                        Ok(()) => log_wrapper(&handle, "startup worker: complete"),
                        Err(error) => {
                            log_wrapper(&handle, &format!("startup worker failed: {error}"));
                            stop_bridge_process(&handle);
                            let _ = close_splash_window(&handle);
                            handle.exit(1);
                        }
                    }
                });
            }
            RunEvent::Exit => {
                stop_bridge_process(&app_handle);
            }
            _ => {}
        });
}

fn initialize_main_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    ensure_bridge_available(app)?;
    log_wrapper(app, "startup worker: bridge available");
    navigate_main_window(app)?;
    log_wrapper(app, "startup worker: main window navigated");
    show_main_window(app)?;
    log_wrapper(app, "startup worker: main window shown");
    close_splash_window(app)?;
    log_wrapper(app, "startup worker: splash closed");
    Ok(())
}

fn ensure_bridge_available(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let project_root = resolve_project_root(app)?;
    let bridge_target = resolve_bridge_target(&project_root);
    log_wrapper(
        app,
        &format!(
            "bridge target resolved: {}:{} at {}",
            bridge_target.host,
            bridge_target.port,
            project_root.display()
        ),
    );

    if wait_for_health(&bridge_target, Duration::from_secs(2)) {
        log::info!(
            "Reusing existing bridge server on http://{}:{}",
            bridge_target.host,
            bridge_target.port
        );
        log_wrapper(app, "bridge health check succeeded without spawning child");
        return Ok(());
    }

    let child = spawn_bridge_process(app, &project_root)?;
    log_wrapper(app, "bridge child process spawned");

    {
        let state = app.state::<BridgeProcessState>();
        let mut slot = state.child.lock().expect("bridge process mutex poisoned");
        *slot = Some(child);
    }

    if wait_for_health(&bridge_target, Duration::from_secs(25)) {
        log::info!("Bridge server started successfully");
        log_wrapper(app, "bridge health check succeeded after spawning child");
        return Ok(());
    }

    log_wrapper(app, "bridge health check timed out");
    stop_bridge_process(app);
    Err("bridge server did not become healthy within 25 seconds".into())
}

fn resolve_project_root(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let Some(project_root) = manifest_dir.parent() else {
            return Err("failed to resolve project root from CARGO_MANIFEST_DIR".into());
        };
        return Ok(project_root.to_path_buf());
    }

    let resource_dir = app.path().resource_dir()?;
    let bundled_project_root = resource_dir.join("_up_");
    if bundled_project_root
        .join("server")
        .join("src")
        .join("index.js")
        .exists()
    {
        return Ok(bundled_project_root);
    }

    Ok(resource_dir)
}

fn spawn_bridge_process(
    app: &AppHandle,
    project_root: &Path,
) -> Result<Child, Box<dyn std::error::Error>> {
    let normalized_project_root = normalize_windows_path(project_root);
    let script_path = normalized_project_root
        .join("server")
        .join("src")
        .join("index.js");
    if !script_path.exists() {
        return Err(format!("bridge entry point not found: {}", script_path.display()).into());
    }

    let env_file = normalized_project_root.join(".env");
    let node_binary = env::var("NODE_EXE").unwrap_or_else(|_| "node".to_string());
    let log_dir = resolve_log_dir(app);
    let stdout_log = log_dir.join("bridge-stdout.log");
    let stderr_log = log_dir.join("bridge-stderr.log");
    let stdout_handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_log)?;
    let stderr_handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_log)?;

    let mut command = Command::new(node_binary);
    if env_file.exists() {
        command.arg(format!("--env-file-if-exists={}", env_file.display()));
    }

    command
        .arg(&script_path)
        .current_dir(&normalized_project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_handle))
        .stderr(Stdio::from(stderr_handle));

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    log::info!("Starting bridge server from {}", project_root.display());
    log_wrapper(
        app,
        &format!(
            "spawning node bridge from {} with stdout={} stderr={}",
            normalized_project_root.display(),
            stdout_log.display(),
            stderr_log.display()
        ),
    );
    Ok(command.spawn()?)
}

fn navigate_main_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let project_root = resolve_project_root(app)?;
    let bridge_target = resolve_bridge_target(&project_root);
    let target_url = Url::parse(&format!(
        "http://{}:{}",
        bridge_target.host, bridge_target.port
    ))?;

    if let Some(window) = app.get_webview_window("main") {
        log_wrapper(app, &format!("navigating main window to {}", target_url));
        window.navigate(target_url)?;
    } else {
        log_wrapper(app, "main window not found during navigation");
    }

    Ok(())
}

fn show_main_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
    } else {
        log_wrapper(app, "main window not found during show");
    }

    Ok(())
}

fn close_splash_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("splash") {
        window.close()?;
    }

    Ok(())
}

fn resolve_bridge_target(project_root: &Path) -> BridgeTarget {
    let env_file = normalize_windows_path(project_root).join(".env");
    let env_text = fs::read_to_string(env_file).unwrap_or_default();
    let mut host = String::from("127.0.0.1");
    let mut port = 3087;

    for line in env_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };

        match key.trim() {
            "HOST" => host = value.trim().to_string(),
            "PORT" => {
                if let Ok(parsed) = value.trim().parse::<u16>() {
                    port = parsed;
                }
            }
            _ => {}
        }
    }

    BridgeTarget { host, port }
}

fn normalize_windows_path(path: &Path) -> PathBuf {
    let value = path.display().to_string();
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }

    path.to_path_buf()
}

fn wait_for_health(target: &BridgeTarget, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if check_health_once(target) {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }

    false
}

fn check_health_once(target: &BridgeTarget) -> bool {
    let Ok(address) = format!("{}:{}", target.host, target.port).parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        HEALTH_PATH, target.host, target.port
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }

    String::from_utf8_lossy(&response).contains(HEALTH_OK_MARKER)
}

fn stop_bridge_process(app: &AppHandle) {
    let state = app.state::<BridgeProcessState>();
    let mut slot = state.child.lock().expect("bridge process mutex poisoned");
    let Some(mut child) = slot.take() else {
        log_wrapper(app, "stop requested with no child process to stop");
        return;
    };

    log::info!("Stopping bridge server child process");
    log_wrapper(app, &format!("stopping child process {}", child.id()));
    let _ = child.kill();
    let _ = child.wait();
}

fn resolve_log_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("codex-discord-connected-display-tauri"));
    let _ = fs::create_dir_all(&base);
    base
}

fn log_wrapper(app: &AppHandle, message: &str) {
    let log_file = resolve_log_dir(app).join("tauri-wrapper.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
        let _ = writeln!(file, "{}", message);
    }
}
