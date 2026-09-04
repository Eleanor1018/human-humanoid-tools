import type { ReactNode } from "react";

export function Inspector({ children }: { children: ReactNode }) {
  return (
    <aside
      className="col-start-3 row-start-2 min-h-0 min-w-0 overflow-hidden border-l border-border-subtle bg-surface"
      aria-label="Inspector"
    >
      {children}
    </aside>
  );
}

export function InspectorPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-[18px]"
      aria-label={title}
    >
      <h1 className="text-[19px] leading-tight font-bold tracking-normal text-foreground">
        {title}
      </h1>
      {children}
    </section>
  );
}
