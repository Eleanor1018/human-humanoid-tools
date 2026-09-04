import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

type IconStyle = CSSProperties & { "--dropzone-icon": string };

interface ImportDropzoneProps {
  label: string;
  icon: string;
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function ImportDropzone({
  label,
  icon,
  title,
  hint,
  children,
  className,
}: ImportDropzoneProps) {
  return (
    <div
      className={cn(
        "flex min-h-[134px] flex-col items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-border bg-background px-9 py-[22px] text-center text-muted-foreground",
        className,
      )}
      role="group"
      aria-label={label}
    >
      <span
        className="size-7 shrink-0 bg-current opacity-[.58] [mask:var(--dropzone-icon)_center/contain_no-repeat] [-webkit-mask:var(--dropzone-icon)_center/contain_no-repeat]"
        style={{ "--dropzone-icon": `url(${icon})` } as IconStyle}
        aria-hidden="true"
      />
      <p className="min-h-[18px] text-[13px] leading-[1.4] font-semibold text-foreground">
        {title}
      </p>
      {hint && <p className="text-[11px] leading-[1.4]">{hint}</p>}
      <div className="mt-0.5 grid w-full grid-flow-col auto-cols-fr gap-2">
        {children}
      </div>
    </div>
  );
}
