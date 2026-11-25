use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use keyring::Entry;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, backup::Backup};
use serde::Serialize;
use tauri::Manager;

pub mod domain;
mod repository;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_app_metadata.sql")),
    (2, include_str!("../migrations/0002_project_domain.sql")),
    (
        3,
        include_str!("../migrations/0003_construction_progress.sql"),
    ),
    (4, include_str!("../migrations/0004_project_address.sql")),
    (5, include_str!("../migrations/0005_construction_units.sql")),
    (6, include_str!("../migrations/0006_asphalt_segments.sql")),
];
const CURRENT_SCHEMA_VERSION: i64 = 6;

struct AppState {
    connection: Mutex<Connection>,
    backup_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseStatus {
    schema_version: i64,
    current_schema_version: i64,
}

fn open_database(path: PathBuf) -> Result<Connection, Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), Box<dyn std::error::Error>> {
    let mut version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Database schema version {version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
        )
        .into());
    }

    for &(target_version, sql) in MIGRATIONS {
        if target_version <= version {
            continue;
        }
        if target_version != version + 1 {
            return Err(format!("Missing database migration after version {version}").into());
        }
        let rebuild_construction_lines = target_version == 5;
        if rebuild_construction_lines {
            connection.pragma_update(None, "foreign_keys", "OFF")?;
        }
        let migration_result = (|| -> Result<(), rusqlite::Error> {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(sql)?;
            transaction.pragma_update(None, "user_version", target_version)?;
            transaction.commit()
        })();
        if rebuild_construction_lines {
            connection.pragma_update(None, "foreign_keys", "ON")?;
        }
        migration_result?;
        version = target_version;
    }

    Ok(())
}

fn backup_database(
    connection: &Connection,
    directory: &Path,
    source: &str,
) -> Result<domain::BackupEntry, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let file_name = format!("{source}-{stamp}.sqlite3");
    let path = directory.join(&file_name);
    let mut target = Connection::open(&path).map_err(|error| error.to_string())?;
    Backup::new(connection, &mut target)
        .map_err(|error| error.to_string())?
        .run_to_completion(5, Duration::from_millis(100), None)
        .map_err(|error| error.to_string())?;
    drop(target);
    backup_entry(&path)
}

fn backup_entry(path: &Path) -> Result<domain::BackupEntry, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Некорректное имя резервной копии".to_string())?
        .to_string();
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Не удалось прочитать резервную копию: {error}"))?;
    let mut statement = connection
        .prepare("SELECT name FROM projects ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let project_names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let modified = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    let source = if file_name.starts_with("before-restore-") {
        "Страховая копия перед восстановлением".to_string()
    } else if file_name.starts_with("before-delete-") {
        "Страховая копия перед удалением объекта".to_string()
    } else {
        "Ручная резервная копия".to_string()
    };
    Ok(domain::BackupEntry {
        file_name,
        created_at: modified,
        project_names,
        source,
        diagnostic: None,
    })
}

fn list_backup_entries(directory: &Path) -> Result<Vec<domain::BackupEntry>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "sqlite3")
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| {
        std::cmp::Reverse(
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok(),
        )
    });
    let mut backups = Vec::with_capacity(paths.len());
    for path in paths {
        match backup_entry(&path) {
            Ok(entry) => backups.push(entry),
            Err(error) => {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("backup.sqlite3")
                    .to_string();
                let created_at = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .map(chrono::DateTime::<chrono::Utc>::from)
                    .map(|value| value.to_rfc3339())
                    .unwrap_or_default();
                backups.push(domain::BackupEntry {
                    file_name,
                    created_at,
                    project_names: Vec::new(),
                    source: "Копия не прошла проверку".into(),
                    diagnostic: Some(error),
                });
            }
        }
    }
    Ok(backups)
}

fn restore_from_backup(
    connection: &mut Connection,
    directory: &Path,
    file_name: &str,
) -> Result<(), String> {
    let requested = Path::new(file_name);
    if requested.file_name().and_then(|name| name.to_str()) != Some(file_name)
        || requested.extension().and_then(|ext| ext.to_str()) != Some("sqlite3")
    {
        return Err("Выбрана некорректная резервная копия".into());
    }
    let source_path = directory.join(requested);
    if !source_path.is_file() {
        return Err("Резервная копия не найдена".into());
    }
    let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Не удалось открыть копию: {error}"))?;
    let version: i64 = source
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Версия схемы копии ({version}) новее текущей версии приложения"
        ));
    }
    let integrity: String = source
        .pragma_query_value(None, "integrity_check", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!("Резервная копия повреждена: {integrity}"));
    }
    let project_count: i64 = source
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| format!("В копии нет корректной модели объектов: {error}"))?;
    if project_count == 0 {
        return Err("Резервная копия не содержит объектов".into());
    }
    let foreign_key_errors = source
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| error.to_string())?
        .query_map([], |_| Ok(()))
        .map_err(|error| error.to_string())?
        .count();
    if foreign_key_errors > 0 {
        return Err("Резервная копия содержит нарушенные связи данных".into());
    }
    let safety_copy = backup_database(connection, directory, "before-restore")?;
    let restore_result: Result<(), String> = (|| {
        Backup::new(&source, connection)
            .map_err(|error| error.to_string())?
            .run_to_completion(5, Duration::from_millis(100), None)
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        migrate(connection).map_err(|error| error.to_string())?;
        repository::record_restore_event(connection)?;
        Ok(())
    })();
    if let Err(error) = restore_result {
        let safety_path = directory.join(safety_copy.file_name);
        let safety = Connection::open_with_flags(safety_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|rollback| format!("Восстановление не удалось ({error}); страховочная копия создана, но её не удалось открыть: {rollback}"))?;
        Backup::new(&safety, connection)
            .and_then(|backup| backup.run_to_completion(5, Duration::from_millis(100), None))
            .map_err(|rollback| format!("Восстановление не удалось ({error}); откат из страховочной копии тоже завершился ошибкой: {rollback}"))?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|rollback| {
                format!("Данные возвращены, но не удалось включить проверку связей: {rollback}")
            })?;
        return Err(format!(
            "Не удалось восстановить копию; исходная база возвращена из страховочной копии: {error}"
        ));
    }
    Ok(())
}

#[tauri::command]
fn database_status(state: tauri::State<'_, AppState>) -> Result<DatabaseStatus, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    let schema_version = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;

    Ok(DatabaseStatus {
        schema_version,
        current_schema_version: CURRENT_SCHEMA_VERSION,
    })
}

#[tauri::command]
fn chat_get_session_token() -> Result<Option<String>, String> {
    let entry = Entry::new("com.easypto.desktop", "chat-session")
        .map_err(|error| format!("Не удалось открыть хранилище учётных данных: {error}"))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Не удалось прочитать сессию чата: {error}")),
    }
}

#[tauri::command]
fn chat_store_session_token(token: String) -> Result<(), String> {
    if token.len() < 40 || token.len() > 256 {
        return Err("Некорректная сессия чата".into());
    }
    Entry::new("com.easypto.desktop", "chat-session")
        .map_err(|error| format!("Не удалось открыть хранилище учётных данных: {error}"))?
        .set_password(&token)
        .map_err(|error| format!("Не удалось сохранить сессию чата: {error}"))
}

#[tauri::command]
fn chat_clear_session_token() -> Result<(), String> {
    let entry = Entry::new("com.easypto.desktop", "chat-session")
        .map_err(|error| format!("Не удалось открыть хранилище учётных данных: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Не удалось удалить сессию чата: {error}")),
    }
}

#[tauri::command]
fn list_projects(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<domain::ProjectListItem>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::list_projects(&connection)
}

#[tauri::command]
fn rename_project(
    state: tauri::State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<Vec<domain::ProjectListItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::rename_project(&mut connection, &project_id, &name)
}

#[tauri::command]
fn set_project_address(
    state: tauri::State<'_, AppState>,
    project_id: String,
    address: String,
) -> Result<Vec<domain::ProjectListItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::set_project_address(&mut connection, &project_id, &address)
}

#[tauri::command]
fn delete_project(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<domain::ProjectListItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    let projects = repository::list_projects(&connection)?;
    if projects.len() <= 1 {
        return Err("Нельзя удалить последний объект".into());
    }
    if !projects.iter().any(|project| project.id == project_id) {
        return Err("Объект не найден".into());
    }
    backup_database(&connection, &state.backup_dir, "before-delete")?;
    repository::delete_project(&mut connection, &project_id)
}

#[tauri::command]
fn list_backups(state: tauri::State<'_, AppState>) -> Result<Vec<domain::BackupEntry>, String> {
    list_backup_entries(&state.backup_dir)
}

#[tauri::command]
fn create_backup(state: tauri::State<'_, AppState>) -> Result<domain::BackupEntry, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    backup_database(&connection, &state.backup_dir, "manual")
}

#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, AppState>,
    file_name: String,
) -> Result<Vec<domain::ProjectListItem>, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    restore_from_backup(&mut connection, &state.backup_dir, &file_name)?;
    repository::list_projects(&connection)
}

#[tauri::command]
fn save_export_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let output = Path::new(&path);
    if !output.is_absolute() {
        return Err("Выберите полный путь для сохранения файла".into());
    }
    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "xlsx" | "docx") {
        return Err("Поддерживаются только файлы Excel (.xlsx) и Word (.docx)".into());
    }
    if bytes.is_empty() {
        return Err("Не удалось сформировать файл отчёта".into());
    }
    fs::write(output, bytes).map_err(|error| format!("Не удалось сохранить отчёт: {error}"))
}

#[tauri::command]
fn create_project(
    state: tauri::State<'_, AppState>,
    name: String,
    route_start_pk: String,
    route_end_pk: String,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::create_project(&mut connection, &name, &route_start_pk, &route_end_pk)
}

#[tauri::command]
fn get_project_snapshot(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<domain::ProjectSnapshot, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::load_snapshot(&connection, &project_id)
}

#[tauri::command]
fn create_layer(
    state: tauri::State<'_, AppState>,
    project_id: String,
    input: domain::LayerInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::create_layer(&mut connection, &project_id, &input)
}

#[tauri::command]
fn update_layer(
    state: tauri::State<'_, AppState>,
    project_id: String,
    layer_id: String,
    input: domain::LayerInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::update_layer(&mut connection, &project_id, &layer_id, &input)
}

#[tauri::command]
fn reorder_layers(
    state: tauri::State<'_, AppState>,
    project_id: String,
    ordered_layer_ids: Vec<String>,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::reorder_layers(&mut connection, &project_id, &ordered_layer_ids)
}

#[tauri::command]
fn delete_layer(
    state: tauri::State<'_, AppState>,
    project_id: String,
    layer_id: String,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_layer(&mut connection, &project_id, &layer_id)
}

#[tauri::command]
fn save_segment(
    state: tauri::State<'_, AppState>,
    project_id: String,
    layer_id: String,
    segment_id: Option<String>,
    input: domain::SegmentInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::save_segment(
        &mut connection,
        &project_id,
        &layer_id,
        segment_id.as_deref(),
        &input,
    )
}

#[tauri::command]
fn delete_segment(
    state: tauri::State<'_, AppState>,
    project_id: String,
    layer_id: String,
    segment_id: String,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_segment(&mut connection, &project_id, &layer_id, &segment_id)
}

#[tauri::command]
fn preview_bridge_config(
    state: tauri::State<'_, AppState>,
    project_id: String,
    input: domain::BridgeConfigInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::preview_bridge_config(&mut connection, &project_id, &input)
}

#[tauri::command]
fn configure_bridge(
    state: tauri::State<'_, AppState>,
    project_id: String,
    input: domain::BridgeConfigInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::configure_bridge(&mut connection, &project_id, &input)
}

#[tauri::command]
fn save_exclusion(
    state: tauri::State<'_, AppState>,
    project_id: String,
    exclusion_id: Option<String>,
    input: domain::ExclusionInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::save_exclusion(
        &mut connection,
        &project_id,
        exclusion_id.as_deref(),
        &input,
    )
}

#[tauri::command]
fn delete_exclusion(
    state: tauri::State<'_, AppState>,
    project_id: String,
    exclusion_id: String,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_exclusion(&mut connection, &project_id, &exclusion_id)
}

#[tauri::command]
fn create_work_area(
    state: tauri::State<'_, AppState>,
    project_id: String,
    input: domain::WorkAreaInput,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::create_work_area(&mut connection, &project_id, &input)
}

#[tauri::command]
fn delete_custom_work_area(
    state: tauri::State<'_, AppState>,
    project_id: String,
    work_area_id: String,
) -> Result<domain::ProjectSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_custom_work_area(&mut connection, &project_id, &work_area_id)
}

#[tauri::command]
fn get_construction_snapshot(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<domain::ConstructionSnapshot, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::load_construction_snapshot(&connection, &project_id)
}

#[tauri::command]
fn create_construction_line(
    state: tauri::State<'_, AppState>,
    project_id: String,
    input: domain::ConstructionLineInput,
) -> Result<domain::ConstructionSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::create_construction_line(&mut connection, &project_id, &input)
}

#[tauri::command]
fn delete_construction_line(
    state: tauri::State<'_, AppState>,
    project_id: String,
    line_id: String,
) -> Result<domain::ConstructionSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_construction_line(&mut connection, &project_id, &line_id)
}

#[tauri::command]
fn rename_construction_line(
    state: tauri::State<'_, AppState>,
    project_id: String,
    line_id: String,
    name: String,
) -> Result<domain::ConstructionSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::rename_construction_line(&mut connection, &project_id, &line_id, &name)
}

#[tauri::command]
fn add_construction_progress(
    state: tauri::State<'_, AppState>,
    project_id: String,
    line_id: String,
    amount: f64,
) -> Result<domain::ConstructionSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::add_construction_progress(&mut connection, &project_id, &line_id, amount)
}

#[tauri::command]
fn update_construction_progress(
    state: tauri::State<'_, AppState>,
    project_id: String,
    line_id: String,
    entry_id: String,
    amount: f64,
) -> Result<domain::ConstructionSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::update_construction_progress(
        &mut connection,
        &project_id,
        &line_id,
        &entry_id,
        amount,
    )
}

#[tauri::command]
fn delete_construction_progress(
    state: tauri::State<'_, AppState>,
    project_id: String,
    line_id: String,
    entry_id: String,
) -> Result<domain::ConstructionSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_construction_progress(&mut connection, &project_id, &line_id, &entry_id)
}

#[tauri::command]
fn get_asphalt_snapshot(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<domain::AsphaltSnapshot, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::load_asphalt_snapshot(&connection, &project_id)
}

#[tauri::command]
fn create_asphalt_segment(
    state: tauri::State<'_, AppState>,
    project_id: String,
    input: domain::AsphaltSegmentInput,
) -> Result<domain::AsphaltSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::create_asphalt_segment(&mut connection, &project_id, &input)
}

#[tauri::command]
fn update_asphalt_segment(
    state: tauri::State<'_, AppState>,
    project_id: String,
    segment_id: String,
    input: domain::AsphaltSegmentInput,
) -> Result<domain::AsphaltSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::update_asphalt_segment(&mut connection, &project_id, &segment_id, &input)
}

#[tauri::command]
fn delete_asphalt_segment(
    state: tauri::State<'_, AppState>,
    project_id: String,
    segment_id: String,
) -> Result<domain::AsphaltSnapshot, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Database connection is unavailable".to_string())?;
    repository::delete_asphalt_segment(&mut connection, &project_id, &segment_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let database_path = app.path().app_data_dir()?.join("easypto.sqlite3");
            let backup_dir = app.path().app_data_dir()?.join("backups");
            let connection = open_database(database_path)?;
            app.manage(AppState {
                connection: Mutex::new(connection),
                backup_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database_status,
            chat_get_session_token,
            chat_store_session_token,
            chat_clear_session_token,
            list_projects,
            rename_project,
            set_project_address,
            delete_project,
            list_backups,
            create_backup,
            restore_backup,
            save_export_file,
            create_project,
            get_project_snapshot,
            create_layer,
            update_layer,
            reorder_layers,
            delete_layer,
            save_segment,
            delete_segment,
            preview_bridge_config,
            configure_bridge,
            save_exclusion,
            delete_exclusion,
            create_work_area,
            delete_custom_work_area,
            get_construction_snapshot,
            create_construction_line,
            delete_construction_line,
            rename_construction_line,
            add_construction_progress,
            update_construction_progress,
            delete_construction_progress,
            get_asphalt_snapshot,
            create_asphalt_segment,
            update_asphalt_segment,
            delete_asphalt_segment
        ])
        .run(tauri::generate_context!())
        .expect("error while running easyPTO");
}
