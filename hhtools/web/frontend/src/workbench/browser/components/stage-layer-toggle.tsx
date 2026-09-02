export interface StageLayerToggleProps {
  readonly id: string;
  readonly title: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly active: boolean;
}

/**
 * Presentational Stage toggle shared by the H2R and R2R HUD rows.
 *
 * Command ownership is intentionally absent here during the migration. H2R
 * passes canonical state; R2R still passes bootstrap presentation values. The
 * compatibility runtime attaches both workflows' existing handlers after commit.
 */
export function StageLayerToggle({
  id,
  title,
  label,
  disabled,
  active,
}: StageLayerToggleProps) {
  return (
    <button
      type="button"
      className={`seg-btn${active ? " on" : ""}`}
      id={id}
      disabled={disabled}
      title={title}
    >
      <span className="eye" aria-hidden="true">
        👁
      </span>
      <span className="lbl">{label}</span>
    </button>
  );
}
