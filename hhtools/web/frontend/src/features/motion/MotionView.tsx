import { useState } from "react";

import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { SearchField } from "@/components/SearchField";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/SegmentedControl";

type MotionProfile = "mimic" | "intermimic" | "meshmimic";

interface MotionProfileOption {
  id: MotionProfile;
  label: string;
  prompt: string;
  icon: string;
  acceptsFile: boolean;
}

const profiles: readonly MotionProfileOption[] = [
  {
    id: "mimic",
    label: "mimic",
    prompt: "Drop a motion file or folder",
    icon: "/icons/motion/film.svg",
    acceptsFile: true,
  },
  {
    id: "intermimic",
    label: "intermimic",
    prompt: "Drop an object-interaction motion folder",
    icon: "/icons/motion/package.svg",
    acceptsFile: false,
  },
  {
    id: "meshmimic",
    label: "meshmimic",
    prompt: "Drop a terrain-motion folder",
    icon: "/icons/motion/mountain.svg",
    acceptsFile: false,
  },
];

const fieldClass =
  "min-h-[30px] min-w-0 truncate rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground";

export function MotionView() {
  // This selection only changes the import shell; file handling arrives with the API hookup.
  const [profile, setProfile] = useState<MotionProfile>("mimic");
  const selected = profiles.find((item) => item.id === profile) ?? profiles[0];

  return (
    <InspectorPage title="Motion">
      <div className="flex shrink-0 flex-col gap-2.5">
        <SegmentedControl
          label="Motion import type"
          items={profiles}
          value={profile}
          onValueChange={setProfile}
        />

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
