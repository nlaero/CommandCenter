import type { Board } from "../types";

type Props = {
  boards: Board[];
  activeBoardId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

export function BoardSwitcher({
  boards,
  activeBoardId,
  onSelect,
  onCreate,
}: Props) {
  return (
    <div className="board-switcher" role="tablist" aria-label="Boards">
      {boards.map((board) => (
        <button
          key={board.id}
          type="button"
          role="tab"
          aria-selected={board.id === activeBoardId}
          className={`board-pill${board.id === activeBoardId ? " active" : ""}`}
          onClick={() => onSelect(board.id)}
        >
          {board.title}
        </button>
      ))}
      <button type="button" className="btn btn-ghost" onClick={onCreate} title="New board">
        +
      </button>
    </div>
  );
}
