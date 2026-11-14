import { useState } from "react";
import {
  clearConfirmation,
  findLocations,
  formatCoords,
  locationFailure,
  readLocationState,
  selectedProvider,
  sourcePhrase,
  withConfirmed,
  withProvider,
  withQuery,
  type LocationProvider,
  type ResolvedLocation,
} from "../lib/location";
import type { AdapterField } from "../types";

const OPTIONS: { id: LocationProvider; title: string; detail: string }[] = [
  {
    id: "gps",
    title: "GPS",
    detail: "Satellite fix from this device",
  },
  {
    id: "network",
    title: "Network location",
    detail: "Wi-Fi, cell, or this device's public IP",
  },
  {
    id: "device",
    title: "Other device sources",
    detail: "The operating system's location service",
  },
  {
    id: "address",
    title: "Address",
    detail: "A street, city, or place you type",
  },
];

type Props = {
  field: AdapterField;
  params: Record<string, unknown>;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
};

export function LocationField({ field, params, disabled, onChange }: Props) {
  const state = readLocationState(params, field);
  const provider = selectedProvider(state);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ResolvedLocation[]>([]);

  function choose(next: LocationProvider) {
    if (next === provider && state.provider === next) return;
    setError(null);
    setCandidates([]);
    onChange(withProvider(params, field, next));
  }

  async function find() {
    if (!provider || disabled || searching) return;
    setSearching(true);
    setError(null);
    setCandidates([]);
    try {
      const matches = await findLocations({
        provider,
        address: state.query,
      });
      if (matches.length === 1) {
        onChange(withConfirmed(params, field, matches[0], state.query));
      } else {
        onChange(clearConfirmation(params, field, provider, state.query));
        setCandidates(matches);
      }
    } catch (err) {
      onChange(clearConfirmation(params, field, provider, state.query));
      setError(locationFailure(err));
    } finally {
      setSearching(false);
    }
  }

  const confirmed = candidates.length ? null : state.confirmed;
  const findLabel = searching ? "Looking…" : provider === "address" ? "Find address" : "Find location";

  return (
    <div className="location-field">
      <div className="location-choices" role="radiogroup" aria-label="Location source">
        {OPTIONS.map((option) => {
          const selected = provider === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`location-choice${selected ? " is-selected" : ""}`}
              disabled={disabled || searching}
              onClick={() => choose(option.id)}
            >
              <span className="location-choice-mark" aria-hidden="true" />
              <span>
                <strong>{option.title}</strong>
                <span>{option.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      {provider === "address" ? (
        <div className="location-address-row">
          <input
            id={`${field.key}-address`}
            value={state.query}
            placeholder="Street, city, region"
            disabled={disabled || searching}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setError(null);
              setCandidates([]);
              onChange(withQuery(params, field, event.target.value));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void find();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled || searching || !state.query.trim()}
            onClick={() => void find()}
          >
            {findLabel}
          </button>
        </div>
      ) : provider ? (
        <div className="location-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled || searching}
            onClick={() => void find()}
          >
            {findLabel}
          </button>
        </div>
      ) : null}

      {searching ? (
        <p className="location-status" role="status">
          {provider === "gps"
            ? "Checking GPS…"
            : provider === "network"
              ? "Checking network location…"
              : provider === "device"
                ? "Checking other location services on this device…"
                : "Looking up that address…"}
        </p>
      ) : null}

      {error ? (
        <div className="alert error" role="alert">
          {error}
        </div>
      ) : null}

      {candidates.length > 1 ? (
        <div className="location-candidates">
          <p className="location-status">Several places matched that address. Pick one.</p>
          {candidates.map((match, index) => (
            <button
              key={`${index}:${match.lat},${match.lon},${match.label}`}
              type="button"
              className="location-candidate"
              disabled={disabled}
              onClick={() => {
                setError(null);
                setCandidates([]);
                onChange(withConfirmed(params, field, match, state.query));
              }}
            >
              <strong>{match.label}</strong>
              <span className="mono">{formatCoords(match.lat, match.lon)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {confirmed ? (
        <div className="location-found" role="status">
          <div className="location-found-title">Location found</div>
          <div className="location-found-label">{confirmed.label}</div>
          <div className="location-found-meta mono">{formatCoords(confirmed.lat, confirmed.lon)}</div>
          <div className="location-found-meta">{sourcePhrase(confirmed.source, confirmed.accuracyM)}</div>
        </div>
      ) : null}
    </div>
  );
}
