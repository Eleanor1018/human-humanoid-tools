import { Search, X } from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

export interface SearchFieldHandle {
  clear(): void;
  focus(): void;
}

interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value"> {
  value: string;
  label: string;
  clearLabel?: string;
  onValueChange(value: string): void;
  onClear?(): void;
}

/** Reusable controlled search field; native input events still reach the
 * compatibility runtime while React remains the source of truth.
 */
export const SearchField = forwardRef<SearchFieldHandle, SearchFieldProps>(
  function SearchField(
    {
      value,
      label,
      clearLabel = "Clear search",
      onValueChange,
      onClear,
      disabled,
      className,
      ...props
    },
    forwardedRef,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    const clear = (): void => {
      if (disabled) return;
      onValueChange("");
      onClear?.();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    useImperativeHandle(forwardedRef, () => ({
      clear,
      focus: () => inputRef.current?.focus(),
    }));

    return (
      <div
        className={cn("search-field", disabled && "disabled", className)}
        role="search"
      >
        <Search
          className="search-field-leading-icon"
          aria-hidden="true"
          data-icon="magnifying-glass"
        />
        <input
          {...props}
          ref={inputRef}
          className="search search-field-input"
          type="search"
          value={value}
          aria-label={label}
          autoComplete={props.autoComplete ?? "off"}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        {value && (
          <button
            type="button"
            className="search-field-clear"
            title={clearLabel}
            aria-label={clearLabel}
            disabled={disabled}
            onClick={clear}
          >
            <X aria-hidden="true" data-icon="x-mark" />
          </button>
        )}
      </div>
    );
  },
);
