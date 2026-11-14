import { useMemo } from "react";
import {
  GridLayout,
  noCompactor,
  type Layout,
  type LayoutItem,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { tvGridChrome } from "../lib/cast";
import { boardGridMetrics, useBoardDensity } from "../lib/display";
import type { AppState, Board, GridItem } from "../types";
import { EmptyBoard } from "./EmptyBoard";
import { PanelCard } from "./PanelCard";

type Props = {
  state: AppState;
  board: Board;
  width: number;
  onOpenSettings: () => void;
  onLayoutChange: (items: GridItem[]) => void;
  /** Television output: no settings button, no layout editing. */
  displayOnly?: boolean;
  /** Overrides the saved row height so the board fills a large screen. */
  rowHeight?: number;
};

function toLayout(items: GridItem[]): Layout {
  return items.map((item) => ({
    i: item.i,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW ?? 6,
    minH: item.minH ?? 8,
  }));
}

function fromLayout(layout: Layout): GridItem[] {
  return layout.map((item: LayoutItem) => ({
    i: item.i,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW,
    minH: item.minH,
  }));
}

export function BoardView({
  state,
  board,
  width,
  onOpenSettings,
  onLayoutChange,
  displayOnly = false,
  rowHeight,
}: Props) {
  const density = useBoardDensity();
  const metrics = boardGridMetrics(state.layout, density);
  const television = rowHeight != null;
  const tvChrome = television ? tvGridChrome(density) : null;
  const layout = useMemo(
    () => toLayout(board.panels.map((p) => p.layout)),
    [board.panels],
  );
  const row = rowHeight ?? metrics.rowHeight;
  const margin: [number, number] = tvChrome
    ? [tvChrome.margin, tvChrome.margin]
    : metrics.margin;
  const padding = tvChrome ? tvChrome.padding : metrics.padding;

  if (board.panels.length === 0) {
    return <EmptyBoard onOpenSettings={onOpenSettings} displayOnly={displayOnly} />;
  }

  return (
    <div
      className={`board-canvas${state.editMode ? " is-editing" : ""}`}
      style={{ ["--cc-board-scale" as string]: String(metrics.scale) }}
    >
      {state.editMode ? (
        <div className="edit-banner" role="status">
          Layout edit mode — drag panels or resize from the corner. Changes save automatically.
        </div>
      ) : null}
      <GridLayout
        key={`grid-${state.editMode ? "edit" : "view"}-${row}-${margin.join("x")}-${padding}`}
        className="layout"
        layout={layout}
        width={Math.max(width, 320)}
        gridConfig={{
          cols: metrics.cols,
          rowHeight: row,
          margin,
          containerPadding: [padding, padding],
          maxRows: Infinity,
        }}
        dragConfig={{
          enabled: state.editMode && !displayOnly,
          handle: ".panel-header",
          cancel: "input,button,a,textarea,select",
          bounded: false,
          threshold: 3,
        }}
        resizeConfig={{
          enabled: state.editMode && !displayOnly,
          handles: ["se", "e", "s"],
        }}
        compactor={noCompactor}
        onDragStop={(next) => onLayoutChange(fromLayout(next))}
        onResizeStop={(next) => onLayoutChange(fromLayout(next))}
      >
        {board.panels.map((panel) => (
          <div key={panel.id}>
            <PanelCard
              panel={panel}
              source={state.sources[panel.source]}
              sources={state.sources}
              editMode={state.editMode}
            />
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
