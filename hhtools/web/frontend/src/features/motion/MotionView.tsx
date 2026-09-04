import { useState } from "react";

import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { SearchField } from "@/components/SearchField";
import { Button } from "@/components/ui/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

type MotionProfile = "mimic" | "intermimic" | "meshmimic";

interface MotionProfileOption {
  id: MotionProfile;
  prompt: string;
  icon: string;
  acceptsFile: boolean;
}

const profiles: readonly MotionProfileOption[] = [
  {
    id: "mimic",
    prompt: "Drop a motion file or folder",
    icon: "/icons/motion/film.svg",
    acceptsFile: true,
  },
  {
    id: "intermimic",
    prompt: "Drop an object-interaction motion folder",
    icon: "/icons/motion/package.svg",
    acceptsFile: false,
  },
  {
    id: "meshmimic",
    prompt: "Drop a terrain-motion folder",
    icon: "/icons/motion/mountain.svg",
    acceptsFile: false,
  },
];

const fieldClass =
  "min-h-[30px] min-w-0 truncate rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground";

function isMotionProfile(value: string): value is MotionProfile {
  return profiles.some((profile) => profile.id === value);
}

export function MotionView() {
  // This selection only changes the import shell; file handling arrives with the API hookup.
  const [profile, setProfile] = useState<MotionProfile>("mimic");
  const selected = profiles.find((item) => item.id === profile) ?? profiles[0];

  return (
    <InspectorPage title="Motion">
      <div className="flex shrink-0 flex-col gap-2.5">
        <ToggleGroup
          type="single"
          value={profile}
          onValueChange={(value) => {
            if (isMotionProfile(value)) setProfile(value);
          }}
          aria-label="Motion import type"
          className="grid w-full grid-cols-3 gap-1.5"
        >
          {profiles.map((item) => (
            <ToggleGroupItem
              key={item.id}
              value={item.id}
              className="h-8 min-h-8 min-w-0 w-full rounded-md border border-border-subtle bg-surface px-1.5 py-1.5 text-[11px] leading-none font-semibold text-muted-foreground hover:border-border hover:bg-background hover:text-foreground data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-accent-foreground data-[state=on]:hover:bg-accent"
            >
              {item.id}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <ImportDropzone
          label={`${profile} import area`}
          icon={selected.icon}
          title={selected.prompt}
        >
          {selected.acceptsFile && (
            <Button size="sm" disabled>
              Choose file
            </Button>
          )}
          <Button size="sm" disabled>
            Choose folder
          </Button>
        </ImportDropzone>
      </div>

      <section
        className="flex min-h-40 flex-[1_1_220px] flex-col gap-2"
        aria-labelledby="motion-library-title"
      >
        <h2
          id="motion-library-title"
          className="text-[19px] leading-tight font-bold tracking-normal text-foreground"
        >
          Library
        </h2>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(110px,42%)] gap-1.5">
          <Button size="sm" disabled>
            Choose library directory
          </Button>
          <select
            className={fieldClass}
            defaultValue="all"
            aria-label="Motion library category"
            disabled
          >
            <option value="all">All</option>
            <option value="motion">Motion</option>
            <option value="object">Object interaction</option>
            <option value="terrain">Terrain scene</option>
          </select>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
          <SearchField
            label="Search the Motion Library"
            placeholder="Search motions..."
            disabled
          />
          <Button size="sm" disabled>
            Link directory
          </Button>
        </div>
        <div className="min-h-[120px] flex-[1_1_220px] rounded-md border border-border-subtle bg-surface" />
      </section>
    </InspectorPage>
  );
}
