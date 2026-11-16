import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type ReportInterval = { fromCentiPk: number; toCentiPk: number };
export type ReportArea = { id: string; kind: "main" | "bridge" | "custom"; name: string; intervals: ReportInterval[] };
export type ReportSegment = { workAreaId: string; fromCentiPk: number; toCentiPk: number; workDate: string; note: string | null };
export type ReportLayer = {
  id: string; code: string; name: string; color: string; baseLayerId: string | null;
  planPercent: number | null; planDate: string | null; workAreaIds: string[]; segments: ReportSegment[];
  workAreaLengthCentiPk: number; coveredLengthCentiPk: number; remainingLengthCentiPk: number;
  progressPercent: number; planDeltaPp: number | null; coveredIntervals: ReportInterval[]; frontLengthCentiPk: number;
  frontIntervals: ReportInterval[];
};
export type ReportExclusion = {
  id: string; name: string; intervals: ReportInterval[]; reason: string;
  appliesToLayerIds: string[]; workAreaIds: string[];
};
export type ReportSnapshot = {
  project: { id: string; name: string; routeStart: number; routeEnd: number };
  calculationVersion: string; bridgeEnabled: boolean; bridgeAreaId: string | null;
  workAreas: ReportArea[]; exclusions: ReportExclusion[]; layers: ReportLayer[];
  summary: { workAreaLengthCentiPk: number; coveredLengthCentiPk: number; remainingLengthCentiPk: number; progressPercent: number; layersBehindPlan: number };
};

const pk = (centiPk: number) => (centiPk / 100).toFixed(2).replace(".", ",");
const km = (centiPk: number) => centiPk / 1000;
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const safeFilePart = (value: string) => value.replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").trim() || "Объект";
const filenameBase = (snapshot: ReportSnapshot) => `${safeFilePart(snapshot.project.name)}_${today()}`;

async function saveBytes(fileName: string, extension: "xlsx" | "docx", bytes: Uint8Array) {
  const path = await save({
    defaultPath: `${fileName}.${extension}`,
    filters: [{ name: extension === "xlsx" ? "Книга Excel" : "Документ Word", extensions: [extension] }],
  });
  if (!path) return false;
  await invoke("save_export_file", { path, bytes: Array.from(bytes) });
  return true;
}

export async function exportExcel(snapshot: ReportSnapshot) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "easyPTO";
  workbook.created = new Date();
  workbook.subject = `Слои дорожной одежды · расчёт ${snapshot.calculationVersion}`;

  const summary = workbook.addWorksheet("Сводка", { views: [{ state: "frozen", ySplit: 1 }] });
  summary.columns = [{ width: 31 }, { width: 28 }, { width: 20 }, { width: 18 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 18 }];
  summary.addRow(["easyPTO · Слои дорожной одежды"]);
  summary.mergeCells("A1:H1");
  summary.getRow(1).font = { bold: true, size: 16, color: { argb: "FF21343B" } };
  summary.addRows([
    ["Объект", snapshot.project.name],
    ["Трасса, ПК", `${pk(snapshot.project.routeStart)} – ${pk(snapshot.project.routeEnd)}`],
    ["Длина трассы, км", km(snapshot.project.routeEnd - snapshot.project.routeStart)],
    ["Дата отчёта", today()],
    ["Версия расчёта", snapshot.calculationVersion],
    ["Выполнение, %", snapshot.summary.progressPercent],
    ["Выполнено, км·слоёв", km(snapshot.summary.coveredLengthCentiPk)],
    ["Рабочая область, км·слоёв", km(snapshot.summary.workAreaLengthCentiPk)],
    ["Осталось, км·слоёв", km(snapshot.summary.remainingLengthCentiPk)],
    ["Слоёв ниже плана", snapshot.summary.layersBehindPlan],
    ["Мост", snapshot.bridgeEnabled ? "Включён" : "Выключен"],
  ]);
  summary.addRow([]);
  const layerHeader = summary.addRow(["Слой", "Рабочая область, км", "Факт, км", "Факт, %", "План, %", "Дата плана", "Δ, п.п.", "Фронт, км"]);
  layerHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  layerHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315F59" } };
  snapshot.layers.forEach((layer) => summary.addRow([
    `${layer.code} · ${layer.name}`, km(layer.workAreaLengthCentiPk), km(layer.coveredLengthCentiPk), layer.progressPercent,
    layer.planPercent, layer.planDate ?? "—", layer.planDeltaPp, km(layer.frontLengthCentiPk),
  ]));
  summary.addRow([]);
  const exclusionHeader = summary.addRow(["Исключения", "Диапазон ПК", "Причина", "Слои", "Области"]);
  exclusionHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  exclusionHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6F6957" } };
  if (snapshot.exclusions.length) snapshot.exclusions.forEach((item) => summary.addRow([
    item.name,
    item.intervals.map((interval) => `${pk(interval.fromCentiPk)}–${pk(interval.toCentiPk)}`).join(", "),
    item.reason,
    item.appliesToLayerIds.map((id) => snapshot.layers.find((layer) => layer.id === id)?.name ?? id).join(", "),
    item.workAreaIds.map((id) => snapshot.workAreas.find((area) => area.id === id)?.name ?? id).join(", "),
  ]));
  else summary.addRow(["Нет исключённых диапазонов"]);
  summary.eachRow((row) => row.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; }));
  summary.getColumn(2).numFmt = "0.00";
  summary.getColumn(3).numFmt = "0.00";
  summary.getColumn(4).numFmt = "0.0";
  summary.getColumn(5).numFmt = "0.0";
  summary.getColumn(7).numFmt = "+0.0;-0.0;0.0";
  summary.getColumn(8).numFmt = "0.00";
  summary.getCell(4, 2).numFmt = "0.000";

  const segments = workbook.addWorksheet("Участки", { views: [{ state: "frozen", ySplit: 1 }] });
  segments.columns = [
    { header: "Слой", key: "layer", width: 25 }, { header: "Рабочая область", key: "area", width: 22 },
    { header: "От, ПК", key: "from", width: 13 }, { header: "До, ПК", key: "to", width: 13 },
    { header: "Длина, км", key: "length", width: 13 }, { header: "Дата выполнения", key: "date", width: 17 },
    { header: "Комментарий", key: "note", width: 42 }, { header: "Статус области", key: "status", width: 23 },
  ];
  const segmentHeader = segments.getRow(1);
  segmentHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  segmentHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315F59" } };
  snapshot.layers.forEach((layer) => layer.segments.forEach((segment) => {
    const area = snapshot.workAreas.find((item) => item.id === segment.workAreaId);
    segments.addRow({
      layer: `${layer.code} · ${layer.name}`,
      area: area?.name ?? "Рабочая область",
      from: segment.fromCentiPk / 100,
      to: segment.toCentiPk / 100,
      length: km(segment.toCentiPk - segment.fromCentiPk),
      date: segment.workDate,
      note: segment.note ?? "",
      status: area?.kind === "bridge" && !snapshot.bridgeEnabled ? "Сохранён · мост отключён" : "Сохранён",
    });
  }));
  for (const column of [segments.getColumn("from"), segments.getColumn("to")]) column.numFmt = "0.00";
  segments.getColumn("length").numFmt = "0.00";
  segments.autoFilter = { from: "A1", to: "H1" };
  const bytes = await workbook.xlsx.writeBuffer();
  return saveBytes(filenameBase(snapshot), "xlsx", new Uint8Array(bytes));
}

export async function exportWord(snapshot: ReportSnapshot) {
  const { BorderStyle, Document, HeadingLevel, PageOrientation, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const cell = (text: string, header = false) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: header })] })],
    shading: header ? { type: ShadingType.SOLID, color: "315F59" } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
  const table = (headers: string[], rows: string[][]) => new Table({
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((item) => cell(item, true)) }),
      ...rows.map((row) => new TableRow({ cantSplit: true, children: headers.map((_, index) => cell(row[index] ?? "—")) })),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 3, color: "D7DFDF" },
      bottom: { style: BorderStyle.SINGLE, size: 3, color: "D7DFDF" },
      left: { style: BorderStyle.SINGLE, size: 3, color: "D7DFDF" },
      right: { style: BorderStyle.SINGLE, size: 3, color: "D7DFDF" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "E5EAEA" },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "E5EAEA" },
    },
  });
  const bridge = snapshot.workAreas.find((area) => area.id === snapshot.bridgeAreaId);
  const children = [
    new Paragraph({ text: "Отчёт по слоям дорожной одежды", heading: HeadingLevel.TITLE }),
    new Paragraph({ text: snapshot.project.name, heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`Трасса: ПК ${pk(snapshot.project.routeStart)} – ${pk(snapshot.project.routeEnd)} · ${(snapshot.project.routeEnd - snapshot.project.routeStart) / 1000} км`),
    new Paragraph(`Дата формирования: ${new Date().toLocaleDateString("ru-RU")} · Версия расчёта: ${snapshot.calculationVersion}`),
    new Paragraph({ text: "Сводка", heading: HeadingLevel.HEADING_1 }),
    table(["Показатель", "Значение"], [
      ["Выполнение по слоям", `${snapshot.summary.progressPercent.toFixed(1).replace(".", ",")}%`],
      ["Выполнено", `${km(snapshot.summary.coveredLengthCentiPk).toFixed(2).replace(".", ",")} км·слоёв`],
      ["Рабочая область", `${km(snapshot.summary.workAreaLengthCentiPk).toFixed(2).replace(".", ",")} км·слоёв`],
      ["Осталось", `${km(snapshot.summary.remainingLengthCentiPk).toFixed(2).replace(".", ",")} км·слоёв`],
      ["Ниже плана", `${snapshot.summary.layersBehindPlan} слоёв`],
      ["Мост", snapshot.bridgeEnabled && bridge ? `Включён · ${bridge.intervals.map((range) => `${pk(range.fromCentiPk)}–${pk(range.toCentiPk)} ПК`).join(", ")}` : "Выключен"],
    ]),
    new Paragraph({ text: "План и факт по слоям", heading: HeadingLevel.HEADING_1 }),
    table(["Слой", "Факт, %", "Факт, км", "План, %", "Дата плана", "Δ, п.п.", "Фронт, км"], snapshot.layers.map((layer) => [
      `${layer.code} · ${layer.name}`, `${layer.progressPercent.toFixed(1).replace(".", ",")}%`, km(layer.coveredLengthCentiPk).toFixed(2).replace(".", ","),
      layer.planPercent === null ? "—" : `${layer.planPercent.toFixed(1).replace(".", ",")}%`, layer.planDate ?? "—",
      layer.planDeltaPp === null ? "—" : layer.planDeltaPp.toFixed(1).replace(".", ","), km(layer.frontLengthCentiPk).toFixed(2).replace(".", ","),
    ])),
    new Paragraph({ text: "Участки работ", heading: HeadingLevel.HEADING_1 }),
    table(["Слой", "От, ПК", "До, ПК", "Длина, км", "Дата", "Область", "Комментарий"], snapshot.layers.flatMap((layer) => layer.segments.map((segment) => [
      `${layer.code} · ${layer.name}`, pk(segment.fromCentiPk), pk(segment.toCentiPk), km(segment.toCentiPk - segment.fromCentiPk).toFixed(2).replace(".", ","),
      segment.workDate, snapshot.workAreas.find((area) => area.id === segment.workAreaId)?.name ?? "—", segment.note ?? "—",
    ]))),
    new Paragraph({ text: "Исключённые диапазоны", heading: HeadingLevel.HEADING_1 }),
    table(["Название", "Диапазон, ПК", "Причина", "Слои", "Области"], snapshot.exclusions.map((item) => [
      item.name, item.intervals.map((range) => `${pk(range.fromCentiPk)}–${pk(range.toCentiPk)}`).join(", "), item.reason,
      item.appliesToLayerIds.map((id) => snapshot.layers.find((layer) => layer.id === id)?.name ?? id).join(", "),
      item.workAreaIds.map((id) => snapshot.workAreas.find((area) => area.id === id)?.name ?? id).join(", "),
    ])),
  ];
  if (!snapshot.exclusions.length) children.push(new Paragraph("Исключённых диапазонов нет."));
  const doc = new Document({
    creator: "easyPTO", title: `Отчёт · ${snapshot.project.name}`, subject: `Расчёт ${snapshot.calculationVersion}`,
    sections: [{ properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } }, children }],
  });
  const blob = await Packer.toBlob(doc);
  return saveBytes(filenameBase(snapshot), "docx", new Uint8Array(await blob.arrayBuffer()));
}
