type Props = {
  onOpenSettings: () => void;
};

export function EmptyBoard({ onOpenSettings }: Props) {
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
