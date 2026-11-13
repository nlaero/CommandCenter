export type GridItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};

export type Panel = {
  id: string;
  title: string;
  widget: string;
  source: string;
  options: Record<string, unknown>;
  layout: GridItem;
};

export type Board = {
  id: string;
  title: string;
  panels: Panel[];
};

export type SourceConfig = {
  type: string;
  params: Record<string, unknown>;
  refresh?: string;
  secrets: string[];
  enabled: boolean;
  draft: boolean;
};

export type LayoutSettings = {
  cols: number;
  rowHeight: number;
  margin: [number, number];
};

export type AppState = {
  version: number;
  activeBoardId: string;
  layout: LayoutSettings;
  boards: Board[];
  sources: Record<string, SourceConfig>;
  editMode: boolean;
};

export type ConfigPaths = {
  root: string;
  configFile: string;
  layoutsDir: string;
  overrideActive: boolean;
  overrideSource?: string | null;
};

export type LoadResult = {
  state: AppState;
  paths: ConfigPaths;
  created: boolean;
};

export type FieldKind = "string" | "number" | "url" | "secret" | "boolean" | "select";

export type AdapterField = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  secret?: boolean;
};

export type AdapterDefinition = {
  typeId: string;
  category: "product" | "foundation";
  name: string;
  description: string;
  defaultWidget: string;
  defaultRefresh?: string;
  fields: AdapterField[];
  stubNote?: string;
};

export type ValidationResult = {
  ok: boolean;
  missing: string[];
  message: string;
};
