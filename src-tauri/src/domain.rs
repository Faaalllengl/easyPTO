use serde::{Deserialize, Serialize};

/// Integer coordinate in hundredths of a picket (1 CentiPk = 1 meter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CentiPk(pub i64);

impl CentiPk {
    /// Parses a PK value without floating-point arithmetic or implicit rounding.
    pub fn parse_pk(value: &str) -> Result<Self, String> {
        let normalized = value.trim().replace(',', ".");
        if normalized.is_empty() || normalized.matches('.').count() > 1 {
            return Err("Введите координату в ПК с точностью до 0,01".into());
        }

        let (negative, unsigned) = match normalized.as_bytes()[0] {
            b'-' => (true, &normalized[1..]),
            b'+' => (false, &normalized[1..]),
            _ => (false, normalized.as_str()),
        };
        if unsigned.is_empty() {
            return Err("Введите числовую координату ПК".into());
        }

        let mut parts = unsigned.split('.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next().unwrap_or_default();
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.len() > 2
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Введите координату в ПК с точностью до 0,01".into());
        }

        let whole: i64 = whole
            .parse()
            .map_err(|_| "Координата выходит за допустимый диапазон".to_string())?;
        let fraction_value: i64 = match fraction.len() {
            0 => 0,
            1 => {
                fraction
                    .parse::<i64>()
                    .map_err(|_| "Введите координату в ПК с точностью до 0,01".to_string())?
                    * 10
            }
            _ => fraction
                .parse()
                .map_err(|_| "Введите координату в ПК с точностью до 0,01".to_string())?,
        };
        let value = whole
            .checked_mul(100)
            .and_then(|amount| amount.checked_add(fraction_value))
            .ok_or_else(|| "Координата выходит за допустимый диапазон".to_string())?;
        let signed = if negative {
            value
                .checked_neg()
                .ok_or_else(|| "Координата выходит за допустимый диапазон".to_string())?
        } else {
            value
        };
        Ok(Self(signed))
    }

    pub fn format_pk(self) -> String {
        let value = i128::from(self.0);
        let sign = if value < 0 { "-" } else { "" };
        let absolute = value.abs();
        format!("{sign}{},{:02}", absolute / 100, absolute % 100)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    pub from_centi_pk: CentiPk,
    pub to_centi_pk: CentiPk,
}

impl Interval {
    pub fn new(from_centi_pk: CentiPk, to_centi_pk: CentiPk) -> Result<Self, String> {
        if to_centi_pk <= from_centi_pk {
            return Err("Конец интервала должен быть больше начала".into());
        }
        Ok(Self {
            from_centi_pk,
            to_centi_pk,
        })
    }

    pub fn length_centi_pk(self) -> u64 {
        (i128::from(self.to_centi_pk.0) - i128::from(self.from_centi_pk.0)) as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkAreaKind {
    Main,
    Bridge,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub route_start: CentiPk,
    pub route_end: CentiPk,
    pub bridge_enabled: bool,
    pub bridge_area_id: Option<String>,
    pub active_calculation_version: String,
    pub layers: Vec<Layer>,
    pub work_areas: Vec<WorkArea>,
    pub exclusions: Vec<Exclusion>,
    pub journal: Vec<JournalEvent>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub code: String,
    pub name: String,
    pub sort_order: i64,
    pub color: String,
    pub base_layer_id: Option<String>,
    pub plan_percent: Option<f64>,
    pub plan_date: Option<String>,
    pub work_area_ids: Vec<String>,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub work_area_id: String,
    pub from_centi_pk: CentiPk,
    pub to_centi_pk: CentiPk,
    pub work_date: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkArea {
    pub id: String,
    pub kind: WorkAreaKind,
    pub name: String,
    pub intervals: Vec<Interval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    pub id: String,
    pub name: String,
    pub intervals: Vec<Interval>,
    pub reason: String,
    pub applies_to_layer_ids: Vec<String>,
    pub work_area_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    pub id: String,
    pub happened_at: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub summary: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    pub id: String,
    pub name: String,
    pub address: String,
    pub route_start: CentiPk,
    pub route_end: CentiPk,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project: ProjectListItem,
    pub calculation_version: String,
    pub bridge_enabled: bool,
    pub bridge_area_id: Option<String>,
    pub work_areas: Vec<WorkArea>,
    pub exclusions: Vec<Exclusion>,
    pub journal: Vec<JournalEvent>,
    pub layers: Vec<LayerSnapshot>,
    pub summary: ProjectSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub file_name: String,
    pub created_at: String,
    pub project_names: Vec<String>,
    pub source: String,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerSnapshot {
    pub id: String,
    pub code: String,
    pub name: String,
    pub sort_order: i64,
    pub color: String,
    pub base_layer_id: Option<String>,
    pub plan_percent: Option<f64>,
    pub plan_date: Option<String>,
    pub work_area_ids: Vec<String>,
    pub segments: Vec<Segment>,
    pub work_area_length_centi_pk: u64,
    pub covered_length_centi_pk: u64,
    pub remaining_length_centi_pk: u64,
    pub progress_percent: f64,
    pub plan_delta_pp: Option<f64>,
    pub covered_intervals: Vec<Interval>,
    pub front_intervals: Vec<Interval>,
    pub front_length_centi_pk: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub work_area_length_centi_pk: u64,
    pub covered_length_centi_pk: u64,
    pub remaining_length_centi_pk: u64,
    pub progress_percent: f64,
    pub layers_behind_plan: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerInput {
    pub code: String,
    pub name: String,
    pub color: String,
    pub plan_percent: Option<f64>,
    pub plan_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentInput {
    pub work_area_id: String,
    pub from_pk: String,
    pub to_pk: String,
    pub work_date: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfigInput {
    pub enabled: bool,
    pub from_pk: String,
    pub to_pk: String,
    pub layer_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionInput {
    pub name: String,
    pub reason: String,
    pub from_pk: String,
    pub to_pk: String,
    pub layer_ids: Vec<String>,
    pub work_area_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkAreaInput {
    pub name: String,
    pub from_pk: String,
    pub to_pk: String,
    pub layer_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionProgressEntry {
    pub id: String,
    pub amount: f64,
    pub happened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionLine {
    pub id: String,
    pub name: String,
    pub unit: String,
    pub planned_amount: f64,
    pub completed_amount: f64,
    pub progress_percent: f64,
    pub sort_order: i64,
    pub entries: Vec<ConstructionProgressEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionSnapshot {
    pub project: ProjectListItem,
    pub lines: Vec<ConstructionLine>,
    pub progress_percent: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionLineInput {
    pub name: String,
    pub unit: String,
    pub planned_amount: f64,
    pub sort_order: i64,
}
