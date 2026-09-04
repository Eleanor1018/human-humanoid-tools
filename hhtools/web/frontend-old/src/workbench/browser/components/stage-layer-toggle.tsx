export interface StageLayerToggleProps {
  readonly id: string;
  readonly title: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly active: boolean;
  readonly onClick?: () => void;
}

/**
 * Presentational Stage toggle shared by the H2R and R2R HUD rows.
 *
 * H2R supplies canonical presentation plus a React command. R2R still passes
 * bootstrap values and omits `onClick`, leaving that workflow on its temporary
 * compatibility handler without duplicating the button markup.
 */
export function StageLayerToggle({
  id,
  title,
  label,
  disabled,
  active,
  onClick,
}: StageLayerToggleProps) {
  return (
    <button
      type="button"
      className={`seg-btn${active ? " on" : ""}`}
      id={id}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      <span className="eye" aria-hidden="true">
        👁
      </span>
      <span className="lbl">{label}</span>
    </button>
  );
}
