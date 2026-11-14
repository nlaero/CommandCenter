type Props = {
  onOpenSettings?: () => void;
  displayOnly?: boolean;
};

export function EmptyBoard({ onOpenSettings, displayOnly = false }: Props) {
  if (displayOnly) {
    return (
      <div className="empty-board">
        <div>
          <h1>Empty board</h1>
          <p>Add a source on the computer. This screen only shows the board.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="empty-board">
      <div>
        <h1>Empty board</h1>
        <p>Add a source in Settings, fill required fields, then place it on the board.</p>
        <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
          Open Settings
        </button>
      </div>
    </div>
  );
}
