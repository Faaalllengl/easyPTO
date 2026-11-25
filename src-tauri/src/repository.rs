use std::collections::{HashMap, HashSet};

use chrono::{NaiveDate, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use crate::domain::{
    AsphaltSegment, AsphaltSegmentInput, AsphaltSnapshot, BridgeConfigInput, CentiPk,
    ConstructionLine, ConstructionLineInput, ConstructionProgressEntry, ConstructionSnapshot,
    Exclusion, ExclusionInput, Interval, LayerInput, LayerSnapshot, ProjectListItem,
    ProjectSnapshot, ProjectSummary, Segment, SegmentInput, WorkArea, WorkAreaInput, WorkAreaKind,
};

type Result<T> = std::result::Result<T, String>;

struct RawLayer {
    id: String,
    code: String,
    name: String,
    sort_order: i64,
    color: String,
    base_layer_id: Option<String>,
    plan_percent: Option<f64>,
    plan_date: Option<String>,
    work_area_ids: Vec<String>,
    active_work_area_ids: HashSet<String>,
    segments: Vec<Segment>,
    workspace: Vec<Interval>,
}

fn id() -> String {
    Uuid::new_v4().to_string()
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn validate_date(value: &str, label: &str) -> Result<()> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("{label}: укажите календарную дату в формате ГГГГ-ММ-ДД"))
}

fn validate_layer_input(input: &LayerInput) -> Result<()> {
    if input.code.trim().is_empty() {
        return Err("Укажите код слоя".into());
    }
    if input.name.trim().is_empty() {
        return Err("Укажите название слоя".into());
    }
    let color = input.color.trim();
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Цвет слоя должен быть в формате #RRGGBB".into());
    }
    match (input.plan_percent, input.plan_date.as_deref()) {
        (None, None) => {}
        (Some(percent), Some(date)) => {
            if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
                return Err("Плановый процент должен быть от 0 до 100".into());
            }
            validate_date(date, "Дата плана")?;
        }
        _ => return Err("Для плана укажите и процент, и дату".into()),
    }
    Ok(())
}

fn touch_project(connection: &Connection, project_id: &str, summary: &str) -> Result<()> {
    let affected = connection
        .execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![timestamp(), project_id],
        )
        .map_err(db_error)?;
    if affected == 0 {
        return Err("Объект не найден".into());
    }
    connection
        .execute(
            "INSERT INTO journal_events (id, project_id, happened_at, action, entity_type, entity_id, summary)
             VALUES (?1, ?2, ?3, 'update', 'project', ?2, ?4)",
            params![id(), project_id, timestamp(), summary],
        )
        .map_err(db_error)?;
    Ok(())
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Ошибка локальной базы данных: {error}")
}

fn validate_construction_amount(unit: &str, amount: f64, label: &str) -> Result<()> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err(format!("{label}: укажите число больше нуля"));
    }
    if amount > 1_000_000_000.0 {
        return Err(format!("{label}: значение превышает допустимый диапазон"));
    }
    if unit == "pieces" && amount.fract() != 0.0 {
        return Err(format!("{label}: количество штук должно быть целым числом"));
    }
    let precision = match unit {
        "meters" | "square_meters" => Some(2),
        "kilometers" | "cubic_meters" | "kilograms" | "tonnes" => Some(3),
        _ => None,
    };
    if let Some(digits) = precision {
        let scale = 10_f64.powi(digits);
        if (amount * scale - (amount * scale).round()).abs() > 1e-7 {
            return Err(format!(
                "{label}: укажите не более {digits} знаков после запятой"
            ));
        }
    }
    Ok(())
}

fn validate_asphalt_measure(value: f64, label: &str) -> Result<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(format!("{label}: укажите число больше нуля"));
    }
    if value > 1_000.0 {
        return Err(format!("{label}: значение превышает допустимый диапазон"));
    }
    let scaled = value * 1_000.0;
    if (scaled - scaled.round()).abs() > 1e-7 {
        return Err(format!("{label}: укажите не более 3 знаков после запятой"));
    }
    Ok(())
}

fn parse_asphalt_interval(input: &AsphaltSegmentInput) -> Result<(CentiPk, CentiPk)> {
    let from = CentiPk::parse_pk(&input.from_pk)?;
    let to = CentiPk::parse_pk(&input.to_pk)?;
    if to <= from {
        return Err("Конец отрезка должен быть больше начала".into());
    }
    validate_asphalt_measure(input.width_m, "Ширина дороги")?;
    validate_asphalt_measure(input.thickness_cm, "Толщина слоя")?;
    Ok((from, to))
}

fn validate_asphalt_interval_bounds(
    connection: &Connection,
    project_id: &str,
    segment_id: Option<&str>,
    from: CentiPk,
    to: CentiPk,
) -> Result<()> {
    let (route_start, route_end): (i64, i64) = connection
        .query_row(
            "SELECT route_start_centi_pk, route_end_centi_pk FROM projects WHERE id = ?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;
    if from.0 < route_start || to.0 > route_end {
        return Err("Пикетаж отрезка должен находиться в границах дороги".into());
    }
    let overlap_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM asphalt_segments
             WHERE project_id = ?1 AND (?2 IS NULL OR id <> ?2)
               AND from_centi_pk < ?4 AND to_centi_pk > ?3",
            params![project_id, segment_id, from.0, to.0],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if overlap_count > 0 {
        return Err(
            "Этот отрезок пересекается с уже добавленным. Укажите свободный участок дороги".into(),
        );
    }
    Ok(())
}

pub fn load_asphalt_snapshot(connection: &Connection, project_id: &str) -> Result<AsphaltSnapshot> {
    let project = connection
        .query_row(
            "SELECT id, name, address, route_start_centi_pk, route_end_centi_pk, updated_at
             FROM projects WHERE id = ?1",
            [project_id],
            |row| {
                Ok(ProjectListItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    address: row.get(2)?,
                    route_start: CentiPk(row.get(3)?),
                    route_end: CentiPk(row.get(4)?),
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;
    let route_length_m = u64::try_from(project.route_end.0 - project.route_start.0)
        .map_err(|_| "Границы дороги заданы некорректно".to_string())?;
    let segments = {
        let mut statement = connection
            .prepare(
                "SELECT id, from_centi_pk, to_centi_pk, width_m, thickness_cm
                 FROM asphalt_segments WHERE project_id = ?1
                 ORDER BY from_centi_pk, to_centi_pk, id",
            )
            .map_err(db_error)?;
        statement
            .query_map([project_id], |row| {
                let from_centi_pk = CentiPk(row.get(1)?);
                let to_centi_pk = CentiPk(row.get(2)?);
                let width_m: f64 = row.get(3)?;
                let thickness_cm: f64 = row.get(4)?;
                let length_m = (to_centi_pk.0 - from_centi_pk.0) as f64;
                Ok(AsphaltSegment {
                    id: row.get(0)?,
                    from_centi_pk,
                    to_centi_pk,
                    width_m,
                    thickness_cm,
                    volume_m3: length_m * width_m * thickness_cm / 100.0,
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    let covered_length_m = segments
        .iter()
        .map(|segment| (segment.to_centi_pk.0 - segment.from_centi_pk.0) as u64)
        .sum::<u64>();
    let total_volume_m3 = segments.iter().map(|segment| segment.volume_m3).sum();
    Ok(AsphaltSnapshot {
        project,
        route_length_m,
        covered_length_m,
        remaining_length_m: route_length_m.saturating_sub(covered_length_m),
        progress_percent: if route_length_m == 0 {
            0.0
        } else {
            covered_length_m as f64 * 100.0 / route_length_m as f64
        },
        total_volume_m3,
        segments,
    })
}

pub fn create_asphalt_segment(
    connection: &mut Connection,
    project_id: &str,
    input: &AsphaltSegmentInput,
) -> Result<AsphaltSnapshot> {
    let (from, to) = parse_asphalt_interval(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    validate_asphalt_interval_bounds(&transaction, project_id, None, from, to)?;
    let segment_id = id();
    let now = timestamp();
    transaction
        .execute(
            "INSERT INTO asphalt_segments (id, project_id, from_centi_pk, to_centi_pk, width_m, thickness_cm, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![segment_id, project_id, from.0, to.0, input.width_m, input.thickness_cm, now],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!(
            "Добавлен асфальтовый участок {}–{} ПК, объём {:.3} м³",
            from.format_pk(),
            to.format_pk(),
            (to.0 - from.0) as f64 * input.width_m * input.thickness_cm / 100.0
        ),
    )?;
    let snapshot = load_asphalt_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn update_asphalt_segment(
    connection: &mut Connection,
    project_id: &str,
    segment_id: &str,
    input: &AsphaltSegmentInput,
) -> Result<AsphaltSnapshot> {
    let (from, to) = parse_asphalt_interval(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM asphalt_segments WHERE project_id = ?1 AND id = ?2)",
            params![project_id, segment_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("Асфальтовый участок не найден".into());
    }
    validate_asphalt_interval_bounds(&transaction, project_id, Some(segment_id), from, to)?;
    transaction
        .execute(
            "UPDATE asphalt_segments SET from_centi_pk = ?1, to_centi_pk = ?2, width_m = ?3, thickness_cm = ?4, updated_at = ?5
             WHERE project_id = ?6 AND id = ?7",
            params![from.0, to.0, input.width_m, input.thickness_cm, timestamp(), project_id, segment_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!(
            "Изменён асфальтовый участок {}–{} ПК, объём {:.3} м³",
            from.format_pk(),
            to.format_pk(),
            (to.0 - from.0) as f64 * input.width_m * input.thickness_cm / 100.0
        ),
    )?;
    let snapshot = load_asphalt_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_asphalt_segment(
    connection: &mut Connection,
    project_id: &str,
    segment_id: &str,
) -> Result<AsphaltSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let interval = transaction
        .query_row(
            "SELECT from_centi_pk, to_centi_pk FROM asphalt_segments WHERE project_id = ?1 AND id = ?2",
            params![project_id, segment_id],
            |row| Ok((CentiPk(row.get(0)?), CentiPk(row.get(1)?))),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Асфальтовый участок не найден".to_string())?;
    transaction
        .execute(
            "DELETE FROM asphalt_segments WHERE project_id = ?1 AND id = ?2",
            params![project_id, segment_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!(
            "Удалён асфальтовый участок {}–{} ПК",
            interval.0.format_pk(),
            interval.1.format_pk()
        ),
    )?;
    let snapshot = load_asphalt_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn load_construction_snapshot(
    connection: &Connection,
    project_id: &str,
) -> Result<ConstructionSnapshot> {
    let project = connection
        .query_row(
            "SELECT id, name, address, route_start_centi_pk, route_end_centi_pk, updated_at
             FROM projects WHERE id = ?1",
            [project_id],
            |row| {
                Ok(ProjectListItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    address: row.get(2)?,
                    route_start: CentiPk(row.get(3)?),
                    route_end: CentiPk(row.get(4)?),
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;

    let mut lines = {
        let mut statement = connection
            .prepare(
                "SELECT id, name, unit, planned_amount, sort_order
                 FROM construction_lines WHERE project_id = ?1
                 ORDER BY sort_order, created_at, id",
            )
            .map_err(db_error)?;
        statement
            .query_map([project_id], |row| {
                Ok(ConstructionLine {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    unit: row.get(2)?,
                    planned_amount: row.get(3)?,
                    completed_amount: 0.0,
                    progress_percent: 0.0,
                    sort_order: row.get(4)?,
                    entries: Vec::new(),
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?
    };

    let mut entries_by_line = HashMap::<String, Vec<ConstructionProgressEntry>>::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT line_id, id, amount, happened_at
                 FROM construction_progress_entries WHERE project_id = ?1
                 ORDER BY happened_at DESC, id DESC",
            )
            .map_err(db_error)?;
        let entries = statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ConstructionProgressEntry {
                        id: row.get(1)?,
                        amount: row.get(2)?,
                        happened_at: row.get(3)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for entry in entries {
            let (line_id, entry) = entry.map_err(db_error)?;
            entries_by_line.entry(line_id).or_default().push(entry);
        }
    }

    let mut progress_sum = 0.0;
    for line in &mut lines {
        line.entries = entries_by_line.remove(&line.id).unwrap_or_default();
        line.completed_amount = line.entries.iter().map(|entry| entry.amount).sum();
        line.progress_percent = line.completed_amount * 100.0 / line.planned_amount;
        progress_sum += line.progress_percent;
    }
    let progress_percent = if lines.is_empty() {
        0.0
    } else {
        progress_sum / lines.len() as f64
    };

    Ok(ConstructionSnapshot {
        project,
        lines,
        progress_percent,
    })
}

pub fn create_construction_line(
    connection: &mut Connection,
    project_id: &str,
    input: &ConstructionLineInput,
) -> Result<ConstructionSnapshot> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Укажите название линии данных".into());
    }
    if !matches!(
        input.unit.as_str(),
        "pieces"
            | "meters"
            | "kilometers"
            | "square_meters"
            | "cubic_meters"
            | "kilograms"
            | "tonnes"
    ) {
        return Err("Выберите единицу измерения из списка".into());
    }
    validate_construction_amount(&input.unit, input.planned_amount, "Проектный объём")?;
    if input.sort_order < 0 {
        return Err("Порядок линии не может быть отрицательным".into());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("Объект не найден".into());
    }
    let now = timestamp();
    transaction
        .execute(
            "INSERT INTO construction_lines (id, project_id, name, unit, planned_amount, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id(), project_id, name, input.unit, input.planned_amount, input.sort_order, now],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Добавлена линия строительства «{name}»"),
    )?;
    let snapshot = load_construction_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_construction_line(
    connection: &mut Connection,
    project_id: &str,
    line_id: &str,
) -> Result<ConstructionSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let name = transaction
        .query_row(
            "SELECT name FROM construction_lines WHERE project_id = ?1 AND id = ?2",
            params![project_id, line_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Линия данных не найдена".to_string())?;
    transaction
        .execute(
            "DELETE FROM construction_lines WHERE project_id = ?1 AND id = ?2",
            params![project_id, line_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Удалена линия строительства «{name}»"),
    )?;
    let snapshot = load_construction_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn rename_construction_line(
    connection: &mut Connection,
    project_id: &str,
    line_id: &str,
    new_name: &str,
) -> Result<ConstructionSnapshot> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("Укажите название линии данных".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let old_name = transaction
        .query_row(
            "SELECT name FROM construction_lines WHERE project_id = ?1 AND id = ?2",
            params![project_id, line_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Линия данных не найдена".to_string())?;
    transaction
        .execute(
            "UPDATE construction_lines SET name = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4",
            params![new_name, timestamp(), project_id, line_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Линия строительства переименована: «{old_name}» → «{new_name}»"),
    )?;
    let snapshot = load_construction_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn update_construction_progress(
    connection: &mut Connection,
    project_id: &str,
    line_id: &str,
    entry_id: &str,
    amount: f64,
) -> Result<ConstructionSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (line_name, unit): (String, String) = transaction
        .query_row(
            "SELECT l.name, l.unit FROM construction_lines l
             JOIN construction_progress_entries e
               ON e.project_id = l.project_id AND e.line_id = l.id
             WHERE e.project_id = ?1 AND e.line_id = ?2 AND e.id = ?3",
            params![project_id, line_id, entry_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Запись выполнения не найдена".to_string())?;
    validate_construction_amount(&unit, amount, "Выполненный объём")?;
    let happened_at = timestamp();
    transaction
        .execute(
            "UPDATE construction_progress_entries SET amount = ?1
             WHERE project_id = ?2 AND line_id = ?3 AND id = ?4",
            params![amount, project_id, line_id, entry_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE construction_lines SET updated_at = ?1 WHERE project_id = ?2 AND id = ?3",
            params![happened_at, project_id, line_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Исправлена запись выполнения «{line_name}»: {amount} {unit}"),
    )?;
    let snapshot = load_construction_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_construction_progress(
    connection: &mut Connection,
    project_id: &str,
    line_id: &str,
    entry_id: &str,
) -> Result<ConstructionSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (line_name, amount, unit): (String, f64, String) = transaction
        .query_row(
            "SELECT l.name, e.amount, l.unit FROM construction_lines l
             JOIN construction_progress_entries e
               ON e.project_id = l.project_id AND e.line_id = l.id
             WHERE e.project_id = ?1 AND e.line_id = ?2 AND e.id = ?3",
            params![project_id, line_id, entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Запись выполнения не найдена".to_string())?;
    transaction
        .execute(
            "DELETE FROM construction_progress_entries WHERE project_id = ?1 AND line_id = ?2 AND id = ?3",
            params![project_id, line_id, entry_id],
        )
        .map_err(db_error)?;
    let now = timestamp();
    transaction
        .execute(
            "UPDATE construction_lines SET updated_at = ?1 WHERE project_id = ?2 AND id = ?3",
            params![now, project_id, line_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Удалена запись выполнения «{line_name}»: {amount} {unit}"),
    )?;
    let snapshot = load_construction_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn add_construction_progress(
    connection: &mut Connection,
    project_id: &str,
    line_id: &str,
    amount: f64,
) -> Result<ConstructionSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (name, unit): (String, String) = transaction
        .query_row(
            "SELECT name, unit FROM construction_lines WHERE project_id = ?1 AND id = ?2",
            params![project_id, line_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Линия данных не найдена".to_string())?;
    validate_construction_amount(&unit, amount, "Выполненный объём")?;
    let happened_at = timestamp();
    transaction
        .execute(
            "INSERT INTO construction_progress_entries (id, project_id, line_id, amount, happened_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id(), project_id, line_id, amount, happened_at],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE construction_lines SET updated_at = ?1 WHERE project_id = ?2 AND id = ?3",
            params![happened_at, project_id, line_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Добавлена запись выполнения «{name}»: {amount} {unit}"),
    )?;
    let snapshot = load_construction_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn list_projects(connection: &Connection) -> Result<Vec<ProjectListItem>> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, address, route_start_centi_pk, route_end_centi_pk, updated_at
             FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(ProjectListItem {
                id: row.get(0)?,
                name: row.get(1)?,
                address: row.get(2)?,
                route_start: CentiPk(row.get(3)?),
                route_end: CentiPk(row.get(4)?),
                updated_at: row.get(5)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)
}

pub fn set_project_address(
    connection: &mut Connection,
    project_id: &str,
    address: &str,
) -> Result<Vec<ProjectListItem>> {
    let address = address.trim();
    let updated = connection
        .execute(
            "UPDATE projects SET address = ?1, updated_at = ?2 WHERE id = ?3",
            params![address, timestamp(), project_id],
        )
        .map_err(db_error)?;
    if updated == 0 {
        return Err("Объект не найден".into());
    }
    list_projects(connection)
}

pub fn rename_project(
    connection: &mut Connection,
    project_id: &str,
    name: &str,
) -> Result<Vec<ProjectListItem>> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Укажите название объекта".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let old_name: Option<String> = transaction
        .query_row(
            "SELECT name FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(old_name) = old_name else {
        return Err("Объект не найден".into());
    };
    transaction
        .execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, timestamp(), project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO journal_events (id, project_id, happened_at, action, entity_type, entity_id, summary, before_json, after_json)
             VALUES (?1, ?2, ?3, 'update', 'project', ?2, ?4, ?5, ?6)",
            params![
                id(), project_id, timestamp(), format!("Объект переименован в «{name}»"),
                serde_json::json!({ "name": old_name }).to_string(),
                serde_json::json!({ "name": name }).to_string()
            ],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    list_projects(connection)
}

pub fn delete_project(
    connection: &mut Connection,
    project_id: &str,
) -> Result<Vec<ProjectListItem>> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(db_error)?;
    if count <= 1 {
        return Err("Нельзя удалить последний объект".into());
    }
    // Break the project's cyclic bridge-area reference before removing work
    // areas. Remove dependent rows explicitly so deletion does not depend on
    // SQLite's cascade order across the project's cyclic and restrictive FKs.
    transaction
        .execute(
            "UPDATE projects SET bridge_enabled = 0, bridge_area_id = NULL WHERE id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM segments WHERE project_id = ?1", [project_id])
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM layer_work_areas WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM exclusion_intervals WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM exclusion_layers WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM exclusion_work_areas WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM exclusions WHERE project_id = ?1", [project_id])
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM work_area_intervals WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM construction_progress_entries WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM construction_lines WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM asphalt_segments WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM journal_events WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE layers SET base_layer_id = NULL WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM layers WHERE project_id = ?1", [project_id])
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM work_areas WHERE project_id = ?1", [project_id])
        .map_err(db_error)?;
    let deleted = transaction
        .execute("DELETE FROM projects WHERE id = ?1", [project_id])
        .map_err(db_error)?;
    if deleted == 0 {
        return Err("Объект не найден".into());
    }
    transaction.commit().map_err(db_error)?;
    list_projects(connection)
}

pub fn record_restore_event(connection: &Connection) -> Result<()> {
    let projects = connection
        .prepare("SELECT id FROM projects")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for project_id in projects {
        connection
            .execute(
                "INSERT INTO journal_events (id, project_id, happened_at, action, entity_type, entity_id, summary)
                 VALUES (?1, ?2, ?3, 'restore', 'project', ?2, 'Объект восстановлен из резервной копии')",
                params![id(), project_id, timestamp()],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

pub fn create_project(
    connection: &mut Connection,
    name: &str,
    route_start_pk: &str,
    route_end_pk: &str,
) -> Result<ProjectSnapshot> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Укажите название объекта".into());
    }
    let route_start = CentiPk::parse_pk(route_start_pk)?;
    let route_end = CentiPk::parse_pk(route_end_pk)?;
    if route_end <= route_start {
        return Err("Конец трассы должен быть больше её начала".into());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let project_id = id();
    let work_area_id = id();
    let created = timestamp();

    transaction
        .execute(
            "INSERT INTO projects
             (id, name, route_start_centi_pk, route_end_centi_pk, bridge_enabled,
              bridge_area_id, active_calculation_version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, NULL, '1', ?5, ?5)",
            params![project_id, name, route_start.0, route_end.0, created],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO journal_events (id, project_id, happened_at, action, entity_type, entity_id, summary)
             VALUES (?1, ?2, ?3, 'create', 'project', ?2, 'Создан объект и стартовая конфигурация слоёв')",
            params![id(), project_id, created],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO work_areas (id, project_id, kind, name)
             VALUES (?1, ?2, 'main', 'Основная трасса')",
            params![work_area_id, project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO work_area_intervals
             (id, project_id, work_area_id, from_centi_pk, to_centi_pk)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id(), project_id, work_area_id, route_start.0, route_end.0],
        )
        .map_err(db_error)?;

    let defaults = [
        ("SMA", "ЩМА", "#c04d3f"),
        ("KZ", "К/З", "#d78235"),
        ("OMS", "ОМС", "#4d7fab"),
        ("RASKLIN", "Расклин.", "#a67b42"),
        ("NSO", "НСО 40–70", "#657781"),
        ("DSO", "ДСО", "#8b9841"),
        ("ZMP", "ЗМП", "#556d62"),
    ];
    let layer_ids = defaults.iter().map(|_| id()).collect::<Vec<_>>();

    // Insert from base to surface so every explicit baseLayerId already exists.
    for index in (0..defaults.len()).rev() {
        let (code, layer_name, color) = defaults[index];
        let base_layer_id = layer_ids.get(index + 1);
        transaction
            .execute(
                "INSERT INTO layers
                 (id, project_id, code, name, sort_order, color, base_layer_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    layer_ids[index],
                    project_id,
                    code,
                    layer_name,
                    index as i64,
                    color,
                    base_layer_id
                ],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO layer_work_areas (project_id, layer_id, work_area_id)
                 VALUES (?1, ?2, ?3)",
                params![project_id, layer_ids[index], work_area_id],
            )
            .map_err(db_error)?;
    }

    let snapshot = load_snapshot(&transaction, &project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn load_snapshot(connection: &Connection, project_id: &str) -> Result<ProjectSnapshot> {
    let project = connection
        .query_row(
            "SELECT id, name, address, route_start_centi_pk, route_end_centi_pk, updated_at,
                    bridge_enabled, bridge_area_id, active_calculation_version
             FROM projects WHERE id = ?1",
            [project_id],
            |row| {
                Ok((
                    ProjectListItem {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        address: row.get(2)?,
                        route_start: CentiPk(row.get(3)?),
                        route_end: CentiPk(row.get(4)?),
                        updated_at: row.get(5)?,
                    },
                    row.get::<_, bool>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;

    let route = Interval::new(project.0.route_start, project.0.route_end)?;
    let mut work_area_statement = connection
        .prepare("SELECT id, kind, name FROM work_areas WHERE project_id = ?1 ORDER BY name")
        .map_err(db_error)?;
    let work_area_rows = work_area_statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(work_area_statement);
    let mut work_areas = Vec::with_capacity(work_area_rows.len());
    for (area_id, kind, name) in work_area_rows {
        let area_kind = match kind.as_str() {
            "main" => WorkAreaKind::Main,
            "bridge" => WorkAreaKind::Bridge,
            "custom" => WorkAreaKind::Custom,
            _ => return Err(format!("Неизвестный тип рабочей области: {kind}")),
        };
        let mut interval_statement = connection
            .prepare(
                "SELECT from_centi_pk, to_centi_pk FROM work_area_intervals
                 WHERE project_id = ?1 AND work_area_id = ?2 ORDER BY from_centi_pk",
            )
            .map_err(db_error)?;
        let intervals = interval_statement
            .query_map(params![project_id, area_id], |row| {
                Ok(Interval {
                    from_centi_pk: CentiPk(row.get(0)?),
                    to_centi_pk: CentiPk(row.get(1)?),
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        work_areas.push(WorkArea {
            id: area_id,
            kind: area_kind,
            name,
            intervals,
        });
    }
    let exclusions = load_exclusions(connection, project_id)?;
    let mut journal_statement = connection
        .prepare(
            "SELECT id, happened_at, action, entity_type, entity_id, summary, before_json, after_json
             FROM journal_events WHERE project_id = ?1 ORDER BY happened_at DESC, id DESC LIMIT 40",
        )
        .map_err(db_error)?;
    let journal = journal_statement
        .query_map([project_id], |row| {
            Ok(crate::domain::JournalEvent {
                id: row.get(0)?,
                happened_at: row.get(1)?,
                action: row.get(2)?,
                entity_type: row.get(3)?,
                entity_id: row.get(4)?,
                summary: row.get(5)?,
                before_json: row.get(6)?,
                after_json: row.get(7)?,
            })
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let active_area_ids = work_areas
        .iter()
        .filter(|area| project.1 || area.kind != WorkAreaKind::Bridge)
        .map(|area| area.id.clone())
        .collect::<HashSet<_>>();
    let mut statement = connection
        .prepare(
            "SELECT id, code, name, sort_order, color, base_layer_id, plan_percent, plan_date
             FROM layers WHERE project_id = ?1 ORDER BY sort_order, id",
        )
        .map_err(db_error)?;
    let records = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<f64>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);

    let mut raw_layers = Vec::with_capacity(records.len());
    for (layer_id, code, name, sort_order, color, base_layer_id, plan_percent, plan_date) in records
    {
        let mut area_statement = connection
            .prepare(
                "SELECT work_area_id FROM layer_work_areas
                 WHERE project_id = ?1 AND layer_id = ?2 ORDER BY work_area_id",
            )
            .map_err(db_error)?;
        let work_area_ids = area_statement
            .query_map(params![project_id, layer_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(area_statement);

        let active_work_area_ids = work_area_ids
            .iter()
            .filter(|area_id| active_area_ids.contains(*area_id))
            .cloned()
            .collect::<HashSet<_>>();
        let mut workspace_parts = Vec::new();
        let mut excluded_parts = Vec::new();
        for work_area_id in &active_work_area_ids {
            let mut interval_statement = connection
                .prepare(
                    "SELECT from_centi_pk, to_centi_pk FROM work_area_intervals
                     WHERE project_id = ?1 AND work_area_id = ?2 ORDER BY from_centi_pk",
                )
                .map_err(db_error)?;
            let intervals = interval_statement
                .query_map(params![project_id, work_area_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(db_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?;
            workspace_parts.extend(intervals);
            let mut exclusion_statement = connection
                .prepare(
                    "SELECT ei.from_centi_pk, ei.to_centi_pk
                     FROM exclusions e
                     JOIN exclusion_layers el ON el.project_id = e.project_id AND el.exclusion_id = e.id
                     JOIN exclusion_work_areas ewa ON ewa.project_id = e.project_id AND ewa.exclusion_id = e.id
                     JOIN exclusion_intervals ei ON ei.project_id = e.project_id AND ei.exclusion_id = e.id
                     WHERE e.project_id = ?1 AND el.layer_id = ?2 AND ewa.work_area_id = ?3",
                )
                .map_err(db_error)?;
            let rows = exclusion_statement
                .query_map(params![project_id, layer_id, work_area_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(db_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?;
            excluded_parts.extend(rows);
        }
        let workspace = intersect_sets(&merge(workspace_parts), &[route]);
        let excluded = intersect_sets(&merge(excluded_parts), &[route]);
        let workspace = subtract_sets(&workspace, &excluded);

        let mut segment_statement = connection
            .prepare(
                "SELECT id, work_area_id, from_centi_pk, to_centi_pk, work_date, note,
                        created_at, updated_at
                 FROM segments WHERE project_id = ?1 AND layer_id = ?2
                 ORDER BY from_centi_pk, to_centi_pk, id",
            )
            .map_err(db_error)?;
        let segments = segment_statement
            .query_map(params![project_id, layer_id], |row| {
                Ok(Segment {
                    id: row.get(0)?,
                    work_area_id: row.get(1)?,
                    from_centi_pk: CentiPk(row.get(2)?),
                    to_centi_pk: CentiPk(row.get(3)?),
                    work_date: row.get(4)?,
                    note: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;

        raw_layers.push(RawLayer {
            id: layer_id,
            code,
            name,
            sort_order,
            color,
            base_layer_id,
            plan_percent,
            plan_date,
            work_area_ids,
            active_work_area_ids,
            segments,
            workspace,
        });
    }

    let mut coverage_by_layer = HashMap::new();
    for layer in &raw_layers {
        let segment_ranges = layer
            .segments
            .iter()
            .filter(|segment| layer.active_work_area_ids.contains(&segment.work_area_id))
            .map(|segment| (segment.from_centi_pk.0, segment.to_centi_pk.0))
            .collect::<Vec<_>>();
        let coverage = intersect_sets(&merge(segment_ranges), &layer.workspace);
        coverage_by_layer.insert(layer.id.clone(), coverage);
    }

    let mut layer_snapshots = Vec::with_capacity(raw_layers.len());
    let mut total_work_area = 0_u64;
    let mut total_covered = 0_u64;
    let mut layers_behind_plan = 0_usize;

    for layer in raw_layers {
        let workspace = layer.workspace.clone();
        let coverage = coverage_by_layer
            .get(&layer.id)
            .cloned()
            .unwrap_or_default();
        let base_coverage = match layer.base_layer_id.as_ref() {
            Some(base_id) => coverage_by_layer.get(base_id).cloned().unwrap_or_default(),
            None => workspace.clone(),
        };
        let front = subtract_sets(&intersect_sets(&base_coverage, &workspace), &coverage);
        let work_area_length = sum_lengths(&workspace)?;
        let covered_length = sum_lengths(&coverage)?.min(work_area_length);
        let remaining_length = work_area_length.saturating_sub(covered_length);
        let progress_percent = if work_area_length == 0 {
            0.0
        } else {
            (covered_length as f64 * 100.0 / work_area_length as f64).min(100.0)
        };
        let plan_delta_pp = layer.plan_percent.map(|plan| progress_percent - plan);
        if plan_delta_pp.is_some_and(|delta| delta < 0.0) {
            layers_behind_plan += 1;
        }
        total_work_area = total_work_area
            .checked_add(work_area_length)
            .ok_or_else(|| {
                "Суммарная длина рабочих областей превышает допустимый диапазон".to_string()
            })?;
        total_covered = total_covered.checked_add(covered_length).ok_or_else(|| {
            "Суммарная длина выполненных работ превышает допустимый диапазон".to_string()
        })?;

        layer_snapshots.push(LayerSnapshot {
            id: layer.id,
            code: layer.code,
            name: layer.name,
            sort_order: layer.sort_order,
            color: layer.color,
            base_layer_id: layer.base_layer_id,
            plan_percent: layer.plan_percent,
            plan_date: layer.plan_date,
            work_area_ids: layer.work_area_ids,
            segments: layer.segments,
            work_area_length_centi_pk: work_area_length,
            covered_length_centi_pk: covered_length,
            remaining_length_centi_pk: remaining_length,
            progress_percent,
            plan_delta_pp,
            covered_intervals: to_intervals(&coverage),
            front_length_centi_pk: sum_lengths(&front)?,
            front_intervals: to_intervals(&front),
        });
    }

    let total_remaining = total_work_area.saturating_sub(total_covered);
    let overall_progress = if total_work_area == 0 {
        0.0
    } else {
        (total_covered as f64 * 100.0 / total_work_area as f64).min(100.0)
    };

    Ok(ProjectSnapshot {
        project: project.0,
        calculation_version: project.3,
        bridge_enabled: project.1,
        bridge_area_id: project.2,
        work_areas,
        exclusions,
        journal,
        layers: layer_snapshots,
        summary: ProjectSummary {
            work_area_length_centi_pk: total_work_area,
            covered_length_centi_pk: total_covered,
            remaining_length_centi_pk: total_remaining,
            progress_percent: overall_progress,
            layers_behind_plan,
        },
    })
}

fn load_exclusions(connection: &Connection, project_id: &str) -> Result<Vec<Exclusion>> {
    let mut statement = connection
        .prepare("SELECT id, name, reason FROM exclusions WHERE project_id = ?1 ORDER BY name, id")
        .map_err(db_error)?;
    let exclusions = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);

    exclusions
        .into_iter()
        .map(|(exclusion_id, name, reason)| {
            let intervals = read_interval_rows(
                connection,
                "SELECT from_centi_pk, to_centi_pk FROM exclusion_intervals
                 WHERE project_id = ?1 AND exclusion_id = ?2 ORDER BY from_centi_pk",
                params![project_id, exclusion_id],
            )?;
            let mut layer_statement = connection
                .prepare(
                    "SELECT layer_id FROM exclusion_layers
                     WHERE project_id = ?1 AND exclusion_id = ?2 ORDER BY layer_id",
                )
                .map_err(db_error)?;
            let applies_to_layer_ids = layer_statement
                .query_map(params![project_id, exclusion_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(db_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?;
            let mut area_statement = connection
                .prepare(
                    "SELECT work_area_id FROM exclusion_work_areas
                     WHERE project_id = ?1 AND exclusion_id = ?2 ORDER BY work_area_id",
                )
                .map_err(db_error)?;
            let work_area_ids = area_statement
                .query_map(params![project_id, exclusion_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(db_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?;
            Ok(Exclusion {
                id: exclusion_id,
                name,
                intervals,
                reason,
                applies_to_layer_ids,
                work_area_ids,
            })
        })
        .collect()
}

fn read_interval_rows(
    connection: &Connection,
    sql: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<Interval>> {
    let mut statement = connection.prepare(sql).map_err(db_error)?;
    statement
        .query_map(values, |row| {
            Ok(Interval {
                from_centi_pk: CentiPk(row.get(0)?),
                to_centi_pk: CentiPk(row.get(1)?),
            })
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn apply_bridge_config(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    input: &BridgeConfigInput,
) -> Result<()> {
    if !input.enabled {
        transaction
            .execute(
                "UPDATE projects SET bridge_enabled = 0 WHERE id = ?1",
                [project_id],
            )
            .map_err(db_error)?;
        return Ok(());
    }

    let from = CentiPk::parse_pk(&input.from_pk)?;
    let to = CentiPk::parse_pk(&input.to_pk)?;
    let bridge = Interval::new(from, to)?;
    let route = transaction
        .query_row(
            "SELECT route_start_centi_pk, route_end_centi_pk FROM projects WHERE id = ?1",
            [project_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;
    if bridge.from_centi_pk.0 < route.0 || bridge.to_centi_pk.0 > route.1 {
        return Err(format!(
            "Границы моста должны лежать внутри трассы {}–{} ПК",
            CentiPk(route.0).format_pk(),
            CentiPk(route.1).format_pk()
        ));
    }
    if input.layer_ids.is_empty() {
        return Err("Выберите хотя бы один слой, к которому относится мост".into());
    }
    let bridge_area_id: Option<String> = transaction
        .query_row(
            "SELECT bridge_area_id FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let bridge_area_id = bridge_area_id.unwrap_or_else(id);
    transaction
        .execute(
            "INSERT INTO work_areas (id, project_id, kind, name) VALUES (?1, ?2, 'bridge', 'Мост')
             ON CONFLICT(id) DO UPDATE SET name = 'Мост'",
            params![bridge_area_id, project_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM work_area_intervals WHERE project_id = ?1 AND work_area_id = ?2",
            params![project_id, bridge_area_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO work_area_intervals (id, project_id, work_area_id, from_centi_pk, to_centi_pk)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id(), project_id, bridge_area_id, from.0, to.0],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE projects SET bridge_enabled = 1, bridge_area_id = ?1 WHERE id = ?2",
            params![bridge_area_id, project_id],
        )
        .map_err(db_error)?;

    let mut valid_layer_statement = transaction
        .prepare("SELECT COUNT(*) FROM layers WHERE project_id = ?1 AND id = ?2")
        .map_err(db_error)?;
    let mut unique_layer_ids = HashSet::new();
    for layer_id in &input.layer_ids {
        if !unique_layer_ids.insert(layer_id) {
            continue;
        }
        let exists: i64 = valid_layer_statement
            .query_row(params![project_id, layer_id], |row| row.get(0))
            .map_err(db_error)?;
        if exists == 0 {
            return Err("Выбранный слой не найден в этом объекте".into());
        }
    }
    drop(valid_layer_statement);
    let mut assigned_statement = transaction
        .prepare(
            "SELECT layer_id FROM layer_work_areas WHERE project_id = ?1 AND work_area_id = ?2",
        )
        .map_err(db_error)?;
    let assigned_layer_ids = assigned_statement
        .query_map(params![project_id, bridge_area_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(assigned_statement);
    for layer_id in assigned_layer_ids {
        if unique_layer_ids.contains(&layer_id) {
            continue;
        }
        let has_segments: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM segments WHERE project_id = ?1 AND layer_id = ?2 AND work_area_id = ?3",
                params![project_id, layer_id, bridge_area_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if has_segments > 0 {
            return Err(format!(
                "Слой «{layer_id}» содержит мостовые отрезки. Сначала переназначьте или удалите их."
            ));
        }
        transaction.execute(
            "DELETE FROM layer_work_areas WHERE project_id = ?1 AND layer_id = ?2 AND work_area_id = ?3",
            params![project_id, layer_id, bridge_area_id],
        ).map_err(db_error)?;
    }
    for layer_id in unique_layer_ids {
        transaction
            .execute(
                "INSERT OR IGNORE INTO layer_work_areas (project_id, layer_id, work_area_id)
                 VALUES (?1, ?2, ?3)",
                params![project_id, layer_id, bridge_area_id],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

pub fn preview_bridge_config(
    connection: &mut Connection,
    project_id: &str,
    input: &BridgeConfigInput,
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    apply_bridge_config(&transaction, project_id, input)?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    drop(transaction);
    Ok(snapshot)
}

pub fn configure_bridge(
    connection: &mut Connection,
    project_id: &str,
    input: &BridgeConfigInput,
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    apply_bridge_config(&transaction, project_id, input)?;
    touch_project(
        &transaction,
        project_id,
        if input.enabled {
            "Настройки моста включены или изменены"
        } else {
            "Мост отключён; настройки и отрезки сохранены"
        },
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn save_exclusion(
    connection: &mut Connection,
    project_id: &str,
    exclusion_id: Option<&str>,
    input: &ExclusionInput,
) -> Result<ProjectSnapshot> {
    let name = input.name.trim();
    let reason = input.reason.trim();
    if name.is_empty() || reason.is_empty() {
        return Err("Укажите название и причину исключённого участка".into());
    }
    if input.layer_ids.is_empty() || input.work_area_ids.is_empty() {
        return Err("Выберите слои и рабочие области для исключения".into());
    }
    let from = CentiPk::parse_pk(&input.from_pk)?;
    let to = CentiPk::parse_pk(&input.to_pk)?;
    let interval = Interval::new(from, to)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let route = transaction
        .query_row(
            "SELECT route_start_centi_pk, route_end_centi_pk FROM projects WHERE id = ?1",
            [project_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;
    if interval.from_centi_pk.0 < route.0 || interval.to_centi_pk.0 > route.1 {
        return Err("Исключённый диапазон должен находиться внутри трассы".into());
    }
    let entity_id = exclusion_id.map(str::to_owned).unwrap_or_else(id);
    let exists: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM exclusions WHERE project_id = ?1 AND id = ?2",
            params![project_id, entity_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if exclusion_id.is_some() && exists == 0 {
        return Err("Исключение не найдено".into());
    }
    transaction
        .execute(
            "INSERT INTO exclusions (id, project_id, name, reason) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, reason = excluded.reason",
            params![entity_id, project_id, name, reason],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM exclusion_intervals WHERE project_id = ?1 AND exclusion_id = ?2",
            params![project_id, entity_id],
        )
        .map_err(db_error)?;
    transaction.execute(
        "INSERT INTO exclusion_intervals (id, project_id, exclusion_id, from_centi_pk, to_centi_pk)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id(), project_id, entity_id, from.0, to.0],
    ).map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM exclusion_layers WHERE project_id = ?1 AND exclusion_id = ?2",
            params![project_id, entity_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM exclusion_work_areas WHERE project_id = ?1 AND exclusion_id = ?2",
            params![project_id, entity_id],
        )
        .map_err(db_error)?;
    for layer_id in &input.layer_ids {
        transaction.execute(
            "INSERT OR IGNORE INTO exclusion_layers (project_id, exclusion_id, layer_id) VALUES (?1, ?2, ?3)",
            params![project_id, entity_id, layer_id],
        ).map_err(db_error)?;
    }
    for work_area_id in &input.work_area_ids {
        transaction.execute(
            "INSERT OR IGNORE INTO exclusion_work_areas (project_id, exclusion_id, work_area_id) VALUES (?1, ?2, ?3)",
            params![project_id, entity_id, work_area_id],
        ).map_err(db_error)?;
    }
    touch_project(
        &transaction,
        project_id,
        &format!("Исключение «{name}» сохранено"),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_exclusion(
    connection: &mut Connection,
    project_id: &str,
    exclusion_id: &str,
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let deleted = transaction
        .execute(
            "DELETE FROM exclusions WHERE project_id = ?1 AND id = ?2",
            params![project_id, exclusion_id],
        )
        .map_err(db_error)?;
    if deleted == 0 {
        return Err("Исключение не найдено".into());
    }
    touch_project(
        &transaction,
        project_id,
        &format!("Удалено исключение {exclusion_id}"),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn create_work_area(
    connection: &mut Connection,
    project_id: &str,
    input: &WorkAreaInput,
) -> Result<ProjectSnapshot> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Укажите название рабочей области".into());
    }
    if input.layer_ids.is_empty() {
        return Err("Выберите хотя бы один слой для рабочей области".into());
    }
    let interval = Interval::new(
        CentiPk::parse_pk(&input.from_pk)?,
        CentiPk::parse_pk(&input.to_pk)?,
    )?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let route = transaction
        .query_row(
            "SELECT route_start_centi_pk, route_end_centi_pk FROM projects WHERE id = ?1",
            [project_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Объект не найден".to_string())?;
    if interval.from_centi_pk.0 < route.0 || interval.to_centi_pk.0 > route.1 {
        return Err("Рабочая область должна находиться внутри границ трассы".into());
    }
    let area_id = id();
    transaction
        .execute(
            "INSERT INTO work_areas (id, project_id, kind, name) VALUES (?1, ?2, 'custom', ?3)",
            params![area_id, project_id, name],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO work_area_intervals (id, project_id, work_area_id, from_centi_pk, to_centi_pk)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id(), project_id, area_id, interval.from_centi_pk.0, interval.to_centi_pk.0],
        )
        .map_err(db_error)?;
    let mut unique_layer_ids = HashSet::new();
    for layer_id in &input.layer_ids {
        if !unique_layer_ids.insert(layer_id) {
            continue;
        }
        let exists: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM layers WHERE project_id = ?1 AND id = ?2",
                params![project_id, layer_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if exists == 0 {
            return Err("Выбранный слой не найден в этом объекте".into());
        }
        transaction
            .execute(
                "INSERT INTO layer_work_areas (project_id, layer_id, work_area_id) VALUES (?1, ?2, ?3)",
                params![project_id, layer_id, area_id],
            )
            .map_err(db_error)?;
    }
    touch_project(
        &transaction,
        project_id,
        &format!("Создана рабочая область «{name}»"),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_custom_work_area(
    connection: &mut Connection,
    project_id: &str,
    work_area_id: &str,
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let kind: Option<String> = transaction
        .query_row(
            "SELECT kind FROM work_areas WHERE project_id = ?1 AND id = ?2",
            params![project_id, work_area_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if kind.as_deref() != Some("custom") {
        return Err("Удалять можно только пользовательские рабочие области".into());
    }
    transaction
        .execute(
            "DELETE FROM segments WHERE project_id = ?1 AND work_area_id = ?2",
            params![project_id, work_area_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM work_areas WHERE project_id = ?1 AND id = ?2",
            params![project_id, work_area_id],
        )
        .map_err(db_error)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Удалена рабочая область {work_area_id} вместе с её отрезками"),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

#[cfg(test)]
mod asphalt_tests {
    use super::*;

    fn database() -> (Connection, String) {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        crate::migrate(&mut connection).expect("apply database migrations");
        let project = create_project(&mut connection, "Тестовая дорога", "1,00", "11,00")
            .expect("create test project");
        (connection, project.project.id)
    }

    fn segment(from_pk: &str, to_pk: &str, width_m: f64, thickness_cm: f64) -> AsphaltSegmentInput {
        AsphaltSegmentInput {
            from_pk: from_pk.into(),
            to_pk: to_pk.into(),
            width_m,
            thickness_cm,
        }
    }

    #[test]
    fn asphalt_crud_calculates_volume_and_rejects_invalid_intervals() {
        let (mut connection, project_id) = database();
        let first = create_asphalt_segment(
            &mut connection,
            &project_id,
            &segment("1,00", "2,00", 7.5, 5.0),
        )
        .expect("create first asphalt section");
        assert_eq!(first.route_length_m, 1_000);
        assert_eq!(first.covered_length_m, 100);
        assert!((first.total_volume_m3 - 37.5).abs() < 1e-9);

        let adjacent = create_asphalt_segment(
            &mut connection,
            &project_id,
            &segment("2,00", "3,00", 8.0, 4.5),
        )
        .expect("allow adjacent asphalt sections");
        assert_eq!(adjacent.covered_length_m, 200);

        assert!(
            create_asphalt_segment(
                &mut connection,
                &project_id,
                &segment("1,50", "2,10", 7.0, 5.0),
            )
            .expect_err("reject overlapping section")
            .contains("пересекается")
        );
        assert!(
            create_asphalt_segment(
                &mut connection,
                &project_id,
                &segment("0,90", "1,10", 7.0, 5.0),
            )
            .expect_err("reject section outside the route")
            .contains("границах")
        );
        assert!(
            create_asphalt_segment(
                &mut connection,
                &project_id,
                &segment("3,00", "3,00", 7.0, 5.0),
            )
            .is_err()
        );
        assert!(
            create_asphalt_segment(
                &mut connection,
                &project_id,
                &segment("3,00", "4,00", 0.0, 5.0),
            )
            .is_err()
        );

        let updated = update_asphalt_segment(
            &mut connection,
            &project_id,
            &first.segments[0].id,
            &segment("1,00", "2,00", 8.0, 6.0),
        )
        .expect("allow updating a segment without treating itself as overlap");
        assert!((updated.segments[0].volume_m3 - 48.0).abs() < 1e-9);
        assert!((updated.total_volume_m3 - 84.0).abs() < 1e-9);

        let deleted = delete_asphalt_segment(&mut connection, &project_id, &first.segments[0].id)
            .expect("delete asphalt segment");
        assert_eq!(deleted.segments.len(), 1);
        assert_eq!(deleted.covered_length_m, 100);
    }

    #[test]
    fn asphalt_measure_validation_rejects_non_finite_and_excess_precision() {
        assert!(validate_asphalt_measure(f64::NAN, "Ширина").is_err());
        assert!(validate_asphalt_measure(0.0, "Ширина").is_err());
        assert!(validate_asphalt_measure(7.1234, "Ширина").is_err());
        assert!(validate_asphalt_measure(7.125, "Ширина").is_ok());
    }

    #[test]
    fn asphalt_migration_preserves_existing_projects() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        for &(version, sql) in crate::MIGRATIONS.iter().take(5) {
            let rebuild_construction_lines = version == 5;
            if rebuild_construction_lines {
                connection
                    .pragma_update(None, "foreign_keys", "OFF")
                    .expect("disable foreign keys for existing migration");
            }
            connection
                .execute_batch(sql)
                .expect("apply prior migration");
            connection
                .pragma_update(None, "user_version", version)
                .expect("record prior schema version");
            if rebuild_construction_lines {
                connection
                    .pragma_update(None, "foreign_keys", "ON")
                    .expect("enable foreign keys after existing migration");
            }
        }
        let project = create_project(&mut connection, "Существующий объект", "2,00", "4,00")
            .expect("create project in schema version 5");
        crate::migrate(&mut connection).expect("upgrade existing database");
        let project_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .expect("read preserved project count");
        assert_eq!(project_count, 1);
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read upgraded schema version");
        assert_eq!(version, 6);
        let snapshot = load_asphalt_snapshot(&connection, &project.project.id)
            .expect("load asphalt data for existing project");
        assert_eq!(snapshot.route_length_m, 200);
        assert!(snapshot.segments.is_empty());
    }
}

fn assign_layer_bases_by_order(connection: &Connection, project_id: &str) -> Result<()> {
    let mut statement = connection
        .prepare("SELECT id FROM layers WHERE project_id = ?1 ORDER BY sort_order, id")
        .map_err(db_error)?;
    let ordered_layer_ids = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);

    connection
        .execute(
            "UPDATE layers SET base_layer_id = NULL WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    for (index, layer_id) in ordered_layer_ids.iter().enumerate() {
        connection
            .execute(
                "UPDATE layers SET base_layer_id = ?1 WHERE project_id = ?2 AND id = ?3",
                params![ordered_layer_ids.get(index + 1), project_id, layer_id],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

pub fn create_layer(
    connection: &mut Connection,
    project_id: &str,
    input: &LayerInput,
) -> Result<ProjectSnapshot> {
    validate_layer_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let sort_order: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM layers WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;

    let layer_id = id();
    transaction
        .execute(
            "INSERT INTO layers
             (id, project_id, code, name, sort_order, color, base_layer_id, plan_percent, plan_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)",
            params![
                layer_id,
                project_id,
                input.code.trim(),
                input.name.trim(),
                sort_order,
                input.color.trim(),
                input.plan_percent,
                input.plan_date
            ],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO layer_work_areas (project_id, layer_id, work_area_id)
             SELECT project_id, ?2, id FROM work_areas
             WHERE project_id = ?1 AND kind = 'main'",
            params![project_id, layer_id],
        )
        .map_err(db_error)?;
    assign_layer_bases_by_order(&transaction, project_id)?;
    touch_project(
        &transaction,
        project_id,
        &format!("Добавлен слой «{}»", input.name.trim()),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn update_layer(
    connection: &mut Connection,
    project_id: &str,
    layer_id: &str,
    input: &LayerInput,
) -> Result<ProjectSnapshot> {
    validate_layer_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let affected = transaction
        .execute(
            "UPDATE layers SET code = ?1, name = ?2, color = ?3,
                    plan_percent = ?4, plan_date = ?5
             WHERE project_id = ?6 AND id = ?7",
            params![
                input.code.trim(),
                input.name.trim(),
                input.color.trim(),
                input.plan_percent,
                input.plan_date,
                project_id,
                layer_id
            ],
        )
        .map_err(db_error)?;
    if affected == 0 {
        return Err("Слой не найден".into());
    }
    touch_project(
        &transaction,
        project_id,
        &format!("Изменён слой «{}»", input.name.trim()),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn reorder_layers(
    connection: &mut Connection,
    project_id: &str,
    ordered_layer_ids: &[String],
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let mut statement = transaction
        .prepare("SELECT id FROM layers WHERE project_id = ?1")
        .map_err(db_error)?;
    let current_layer_ids = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<std::result::Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    let submitted_layer_ids = ordered_layer_ids.iter().collect::<HashSet<_>>();
    if ordered_layer_ids.len() != current_layer_ids.len()
        || submitted_layer_ids.len() != ordered_layer_ids.len()
        || ordered_layer_ids
            .iter()
            .any(|layer_id| !current_layer_ids.contains(layer_id))
    {
        return Err("Список слоёв изменился. Обновите объект и попробуйте ещё раз".into());
    }

    // Clear the existing graph first so any valid new ordering can be applied
    // without transient cycles or RESTRICT violations between base layers.
    transaction
        .execute(
            "UPDATE layers SET base_layer_id = NULL WHERE project_id = ?1",
            [project_id],
        )
        .map_err(db_error)?;
    for (index, layer_id) in ordered_layer_ids.iter().enumerate() {
        let base_layer_id = ordered_layer_ids.get(index + 1);
        transaction
            .execute(
                "UPDATE layers SET sort_order = ?1, base_layer_id = ?2
                 WHERE project_id = ?3 AND id = ?4",
                params![index as i64, base_layer_id, project_id, layer_id],
            )
            .map_err(db_error)?;
    }
    touch_project(
        &transaction,
        project_id,
        "Изменён порядок слоёв и переназначены базовые слои",
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_layer(
    connection: &mut Connection,
    project_id: &str,
    layer_id: &str,
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let replacement_base_layer_id: Option<Option<String>> = transaction
        .query_row(
            "SELECT base_layer_id FROM layers WHERE project_id = ?1 AND id = ?2",
            params![project_id, layer_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(replacement_base_layer_id) = replacement_base_layer_id else {
        return Err("Слой не найден".into());
    };
    transaction
        .execute(
            "UPDATE layers SET base_layer_id = ?1
             WHERE project_id = ?2 AND base_layer_id = ?3",
            params![replacement_base_layer_id, project_id, layer_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM segments WHERE project_id = ?1 AND layer_id = ?2",
            params![project_id, layer_id],
        )
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM layer_work_areas WHERE project_id = ?1 AND layer_id = ?2",
            params![project_id, layer_id],
        )
        .map_err(db_error)?;
    let affected = transaction
        .execute(
            "DELETE FROM layers WHERE project_id = ?1 AND id = ?2",
            params![project_id, layer_id],
        )
        .map_err(db_error)?;
    if affected == 0 {
        return Err("Слой не найден".into());
    }
    touch_project(
        &transaction,
        project_id,
        &format!("Удалён слой {layer_id} вместе с его отрезками"),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn save_segment(
    connection: &mut Connection,
    project_id: &str,
    layer_id: &str,
    segment_id: Option<&str>,
    input: &SegmentInput,
) -> Result<ProjectSnapshot> {
    let from = CentiPk::parse_pk(&input.from_pk)?;
    let to = CentiPk::parse_pk(&input.to_pk)?;
    let interval = Interval::new(from, to)?;
    validate_date(&input.work_date, "Дата выполнения")?;
    let work_area_id = input.work_area_id.trim();
    if work_area_id.is_empty() {
        return Err("Выберите рабочую область для отрезка".into());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let route: Option<(i64, i64)> = transaction
        .query_row(
            "SELECT route_start_centi_pk, route_end_centi_pk FROM projects WHERE id = ?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let Some((route_start, route_end)) = route else {
        return Err("Объект не найден".into());
    };
    if from.0 < route_start || to.0 > route_end {
        return Err(format!(
            "Отрезок {}–{} ПК выходит за границы трассы {}–{} ПК",
            from.format_pk(),
            to.format_pk(),
            CentiPk(route_start).format_pk(),
            CentiPk(route_end).format_pk()
        ));
    }

    let area_bounds: Vec<(i64, i64)> = {
        let mut statement = transaction
            .prepare(
                "SELECT wai.from_centi_pk, wai.to_centi_pk
                 FROM work_area_intervals wai
                 JOIN layer_work_areas lwa
                   ON lwa.project_id = wai.project_id AND lwa.work_area_id = wai.work_area_id
                 WHERE lwa.project_id = ?1 AND lwa.layer_id = ?2 AND lwa.work_area_id = ?3",
            )
            .map_err(db_error)?;
        statement
            .query_map(params![project_id, layer_id, work_area_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    if !area_bounds
        .iter()
        .any(|(area_start, area_end)| from.0 >= *area_start && to.0 <= *area_end)
    {
        return Err(
            "Отрезок должен полностью помещаться в рабочую область, назначенную этому слою".into(),
        );
    }

    let conflict: Option<(i64, i64)> = if let Some(current_id) = segment_id {
        transaction
            .query_row(
                "SELECT from_centi_pk, to_centi_pk FROM segments
                 WHERE project_id = ?1 AND layer_id = ?2 AND work_area_id = ?3 AND id <> ?4
                   AND from_centi_pk < ?5 AND to_centi_pk > ?6 LIMIT 1",
                params![project_id, layer_id, work_area_id, current_id, to.0, from.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
    } else {
        transaction
            .query_row(
                "SELECT from_centi_pk, to_centi_pk FROM segments
                 WHERE project_id = ?1 AND layer_id = ?2 AND work_area_id = ?3
                   AND from_centi_pk < ?4 AND to_centi_pk > ?5 LIMIT 1",
                params![project_id, layer_id, work_area_id, to.0, from.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
    };
    if let Some((conflict_from, conflict_to)) = conflict {
        return Err(format!(
            "Пересекается с сохранённым отрезком {}–{} ПК; скорректируйте границы",
            CentiPk(conflict_from).format_pk(),
            CentiPk(conflict_to).format_pk()
        ));
    }

    let clean_note = input
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty());
    let now = timestamp();
    if let Some(current_id) = segment_id {
        let affected = transaction
            .execute(
                "UPDATE segments SET work_area_id = ?1, from_centi_pk = ?2,
                        to_centi_pk = ?3, work_date = ?4, note = ?5, updated_at = ?6
                 WHERE project_id = ?7 AND layer_id = ?8 AND id = ?9",
                params![
                    work_area_id,
                    interval.from_centi_pk.0,
                    interval.to_centi_pk.0,
                    input.work_date,
                    clean_note,
                    now,
                    project_id,
                    layer_id,
                    current_id
                ],
            )
            .map_err(db_error)?;
        if affected == 0 {
            return Err("Отрезок не найден".into());
        }
    } else {
        transaction
            .execute(
                "INSERT INTO segments
                 (id, project_id, layer_id, work_area_id, from_centi_pk, to_centi_pk,
                  work_date, note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    id(),
                    project_id,
                    layer_id,
                    work_area_id,
                    interval.from_centi_pk.0,
                    interval.to_centi_pk.0,
                    input.work_date,
                    clean_note,
                    now
                ],
            )
            .map_err(db_error)?;
    }

    touch_project(
        &transaction,
        project_id,
        &format!(
            "Отрезок слоя {layer_id}: ПК {}–{} сохранён",
            from.format_pk(),
            to.format_pk()
        ),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

pub fn delete_segment(
    connection: &mut Connection,
    project_id: &str,
    layer_id: &str,
    segment_id: &str,
) -> Result<ProjectSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let affected = transaction
        .execute(
            "DELETE FROM segments WHERE project_id = ?1 AND layer_id = ?2 AND id = ?3",
            params![project_id, layer_id, segment_id],
        )
        .map_err(db_error)?;
    if affected == 0 {
        return Err("Отрезок не найден".into());
    }
    touch_project(
        &transaction,
        project_id,
        &format!("Удалён отрезок {segment_id} слоя {layer_id}"),
    )?;
    let snapshot = load_snapshot(&transaction, project_id)?;
    transaction.commit().map_err(db_error)?;
    Ok(snapshot)
}

fn merge(mut intervals: Vec<(i64, i64)>) -> Vec<Interval> {
    intervals.retain(|(from, to)| to > from);
    intervals.sort_unstable_by_key(|(from, to)| (*from, *to));
    let mut merged: Vec<(i64, i64)> = Vec::with_capacity(intervals.len());
    for (from, to) in intervals {
        if let Some(last) = merged.last_mut() {
            if from <= last.1 {
                last.1 = last.1.max(to);
                continue;
            }
        }
        merged.push((from, to));
    }
    merged
        .into_iter()
        .filter_map(|(from, to)| Interval::new(CentiPk(from), CentiPk(to)).ok())
        .collect()
}

fn intersect_sets(left: &[Interval], right: &[Interval]) -> Vec<Interval> {
    let mut intersections = Vec::new();
    let (mut left_index, mut right_index) = (0, 0);
    while left_index < left.len() && right_index < right.len() {
        let start = left[left_index]
            .from_centi_pk
            .0
            .max(right[right_index].from_centi_pk.0);
        let end = left[left_index]
            .to_centi_pk
            .0
            .min(right[right_index].to_centi_pk.0);
        if end > start {
            intersections.push((start, end));
        }
        if left[left_index].to_centi_pk <= right[right_index].to_centi_pk {
            left_index += 1;
        } else {
            right_index += 1;
        }
    }
    merge(intersections)
}

fn subtract_sets(source: &[Interval], subtract: &[Interval]) -> Vec<Interval> {
    let mut output = Vec::new();
    let mut subtract_index = 0;
    for interval in source {
        let mut cursor = interval.from_centi_pk.0;
        while subtract_index < subtract.len() && subtract[subtract_index].to_centi_pk.0 <= cursor {
            subtract_index += 1;
        }
        let mut index = subtract_index;
        while index < subtract.len() && subtract[index].from_centi_pk.0 < interval.to_centi_pk.0 {
            if subtract[index].from_centi_pk.0 > cursor {
                output.push((cursor, subtract[index].from_centi_pk.0));
            }
            cursor = cursor.max(subtract[index].to_centi_pk.0);
            if cursor >= interval.to_centi_pk.0 {
                break;
            }
            index += 1;
        }
        if cursor < interval.to_centi_pk.0 {
            output.push((cursor, interval.to_centi_pk.0));
        }
    }
    merge(output)
}

fn sum_lengths(intervals: &[Interval]) -> Result<u64> {
    intervals.iter().try_fold(0_u64, |total, interval| {
        total
            .checked_add(interval.length_centi_pk())
            .ok_or_else(|| "Суммарная длина превышает допустимый диапазон".to_string())
    })
}

fn to_intervals(intervals: &[Interval]) -> Vec<Interval> {
    intervals.to_vec()
}
