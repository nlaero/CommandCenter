import { useEffect, useState } from "react";
import {
  isPreviewInput,
  listLocalAudioInputs,
  localInputKindLabel,
  refreshLocalAudioInputs,
  type LocalAudioInput,
} from "../lib/localAudio";

type Props = {
  params: Record<string, unknown>;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
};

export function LocalAudioField({ params, disabled, onChange }: Props) {
  const deviceId = String(params.deviceId ?? "");
  const deviceLabel = String(params.deviceLabel ?? "");
  const [devices, setDevices] = useState<LocalAudioInput[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listLocalAudioInputs().then((next) => {
      if (cancelled) return;
      setDevices(next);
      setNote(previewNote(next));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const known = devices.some((device) => device.id === deviceId);

  return (
    <div>
      <div className="safety-device-row">
        <select
          id="deviceId"
          value={deviceId}
          disabled={disabled}
          onChange={(event) => {
            const id = event.target.value;
            const device = devices.find((item) => item.id === id);
            onChange({
              ...params,
              deviceId: id,
              deviceLabel: device?.label ?? "",
              inputKind: device?.kind ?? "",
            });
          }}
        >
          <option value="">Select…</option>
          {deviceId && !known ? (
            <option value={deviceId}>{deviceLabel || "Saved input"}</option>
          ) : null}
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label} · {localInputKindLabel(device.kind)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => {
            void refreshLocalAudioInputs().then((next) => {
              setDevices(next);
              setNote(previewNote(next));
            });
          }}
        >
          Refresh
        </button>
      </div>
      {note ? <div className="help">{note}</div> : null}
    </div>
  );
}

function previewNote(devices: LocalAudioInput[]): string | null {
  if (devices.some((device) => isPreviewInput(device.id))) {
    return "Browser preview. The desktop app lists the jack and Bluetooth inputs on this computer.";
  }
  if (!devices.length) return "No jack or Bluetooth input is connected.";
  return null;
}
