import { booleanFieldChecked } from "../lib/formFields";
import { applyBroadcastifyPreset, PENN_HILLS_FEED } from "../lib/broadcastifyPreset";
import { fillTransitUrls } from "../lib/sourceDraft";
import type { AdapterDefinition, AdapterField } from "../types";
import { LocalAudioField } from "./LocalAudioField";
import { LocationField } from "./LocationField";
import { NewsOutletsField } from "./NewsOutletsField";
import { PrivateCameraField } from "./PrivateCameraField";
import { PublicCamerasField } from "./PublicCamerasField";
import { SafetyFeedsField } from "./SafetyFeedsField";
import { WeatherMapsField } from "./WeatherMapsField";

type Props = {
  adapter: AdapterDefinition;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  sources: Record<string, { type: string; params: Record<string, unknown> }>;
  busy?: boolean;
  editing?: boolean;
  onParams: (params: Record<string, unknown>) => void;
  onSecrets: (secrets: Record<string, string>) => void;
};

function applyProviderDefaults(provider: string, prev: Record<string, unknown>) {
  const chicago = "City of Chicago Open Data — Crimes 2001 to Present";
  const seattle = "City of Seattle Open Data — SPD Crime Data";
  const current = typeof prev.attribution === "string" ? prev.attribution.trim() : "";
  const stillPreset = current === "" || current === chicago || current === seattle;
  if (provider === "chicago" || provider === "seattle") {
    return {
      ...prev,
      provider,
      attribution: stillPreset ? (provider === "seattle" ? seattle : chicago) : current,
      limit: prev.limit === undefined || prev.limit === "" ? 50 : prev.limit,
    };
  }
  return { ...prev, provider };
}

function secretName(field: AdapterField): string {
  return field.key.startsWith("secret:") ? field.key.slice("secret:".length) : field.key;
}

export function SourceFields({
  adapter,
  params,
  secrets,
  sources,
  busy,
  editing,
  onParams,
  onSecrets,
}: Props) {
  function change(field: AdapterField, raw: string | boolean) {
    if (field.kind === "secret" || field.secret || field.key.startsWith("secret:")) {
      onSecrets({ ...secrets, [secretName(field)]: String(raw) });
      return;
    }
    if (field.kind === "boolean") {
      onParams({ ...params, [field.key]: Boolean(raw) });
      return;
    }
    if (field.kind === "number") {
      onParams({ ...params, [field.key]: raw === "" ? "" : Number(raw) });
      return;
    }
    if (field.key === "provider") {
      onParams(applyProviderDefaults(String(raw), params));
      return;
    }
    if (field.key === "preset" && adapter.typeId === "broadcastify.owner") {
      const nextPreset = String(raw);
      onParams(applyBroadcastifyPreset(nextPreset, params));
      if (nextPreset !== "custom" && !secrets["broadcastify.username"]?.trim()) {
        onSecrets({ ...secrets, "broadcastify.username": PENN_HILLS_FEED.username });
      }
      return;
    }
    if (field.key === "feedId" && adapter.typeId === "broadcastify.owner") {
      const feedId = String(raw).trim();
      onParams({
        ...params,
        feedId: raw,
        preset:
          feedId === PENN_HILLS_FEED.feedId
            ? PENN_HILLS_FEED.preset
            : params.preset === PENN_HILLS_FEED.preset
              ? "custom"
              : params.preset,
      });
      return;
    }
    onParams({ ...params, [field.key]: raw });
  }

  return (
    <div className="form-grid">
      {adapter.fields.map((field) => {
        if (field.kind === "weatherMaps") {
          return (
            <div className="field" key={field.key}>
              <label>
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
              </label>
              <WeatherMapsField
                params={params}
                disabled={busy}
                help={field.help}
                onChange={onParams}
              />
            </div>
          );
        }
        if (field.kind === "checklist") {
          return (
            <div className="field" key={field.key}>
              <label>
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
              </label>
              <NewsOutletsField params={params} disabled={busy} help={field.help} onChange={onParams} />
            </div>
          );
        }
        if (field.kind === "feeds") {
          return (
            <div className="field" key={field.key}>
              <label>
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
              </label>
              <SafetyFeedsField params={params} sources={sources} disabled={busy} onChange={onParams} />
              {field.help ? <div className="help">{field.help}</div> : null}
            </div>
          );
        }
        if (field.kind === "audio") {
          return (
            <div className="field" key={field.key}>
              <label htmlFor={field.key}>
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
              </label>
              <LocalAudioField params={params} disabled={busy} onChange={onParams} />
              {field.help ? <div className="help">{field.help}</div> : null}
            </div>
          );
        }
        if (field.kind === "publicCameras" || field.kind === "privateCamera") {
          return (
            <div className="field" key={field.key}>
              <label>
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
              </label>
              {field.kind === "publicCameras" ? (
                <PublicCamerasField params={params} disabled={busy} onChange={onParams} />
              ) : (
                <PrivateCameraField params={params} disabled={busy} onChange={onParams} />
              )}
              {field.help ? <div className="help">{field.help}</div> : null}
            </div>
          );
        }
        const isSecret = field.kind === "secret" || field.secret || field.key.startsWith("secret:");
        const value = isSecret
          ? (secrets[secretName(field)] ?? "")
          : field.kind === "boolean"
            ? booleanFieldChecked(field, params[field.key])
            : params[field.key] === undefined || params[field.key] === null
              ? ""
              : String(params[field.key]);
        return (
          <div className="field" key={field.key}>
            <label htmlFor={`${adapter.typeId}-${field.key}`}>
              {field.label}
              {field.required && !(editing && isSecret) ? <span className="req"> *</span> : null}
            </label>
            {field.kind === "location" && field.help ? (
              <div className="help location-help">{field.help}</div>
            ) : null}
            {field.kind === "location" ? (
              <LocationField
                field={field}
                params={params}
                disabled={busy}
                onChange={(next) =>
                  onParams(adapter.typeId === "transit.gtfs" ? fillTransitUrls(next) : next)
                }
              />
            ) : field.kind === "boolean" ? (
              <input
                id={`${adapter.typeId}-${field.key}`}
                type="checkbox"
                checked={Boolean(value)}
                disabled={busy}
                onChange={(event) => change(field, event.target.checked)}
              />
            ) : field.kind === "select" ? (
              <select
                id={`${adapter.typeId}-${field.key}`}
                value={String(value)}
                disabled={busy}
                onChange={(event) => change(field, event.target.value)}
              >
                <option value="">Select…</option>
                {(field.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${adapter.typeId}-${field.key}`}
                type={field.kind === "secret" ? "password" : field.kind === "number" ? "number" : "text"}
                placeholder={editing && isSecret ? "Leave blank to keep stored secret" : field.placeholder}
                value={String(value)}
                disabled={busy}
                onChange={(event) => change(field, event.target.value)}
                onWheel={
                  field.kind === "number"
                    ? (event) => {
                        event.currentTarget.blur();
                      }
                    : undefined
                }
                autoComplete="off"
              />
            )}
            {field.help && field.kind !== "location" ? <div className="help">{field.help}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
