import {
  isSmplxNeutralMissing,
  SMPLX_DOWNLOAD_URL,
  SMPLX_LICENSE_URL,
  type GvhmrRuntimeStatus,
} from "./api";
import { useLocaleText } from "@/LocaleProvider";

export function SmplxModelLinks({
  runtime,
}: {
  readonly runtime: GvhmrRuntimeStatus | null;
}) {
  const text = useLocaleText();
  if (!isSmplxNeutralMissing(runtime)) return null;
  const bodyModelsRoot = runtime?.body_models_root?.replace(/[\\/]$/, "");
  const pathSeparator = bodyModelsRoot?.includes("\\") ? "\\" : "/";
  const requiredPath = bodyModelsRoot
    ? `${bodyModelsRoot}${pathSeparator}smplx${pathSeparator}SMPLX_NEUTRAL.npz`
    : null;

  return (
    <aside
      className="grid gap-1.5 rounded-md border border-warning-border bg-warning-muted px-2.5 py-2 text-[11px] leading-relaxed text-warning"
      aria-label={text("SMPL-X model setup", "SMPL-X 模型配置")}
    >
      <p className="font-semibold">
        {text("Licensed SMPL-X neutral model required", "需要已授权的 SMPL-X neutral 模型")}
      </p>
      <p>
        {text(
          "Sign in or register on the official site, accept its license, and obtain",
          "请在官方网站登录或注册、接受许可证并下载",
        )}
        <code className="mx-1 font-mono text-foreground">SMPLX_NEUTRAL.npz</code>.
      </p>
      {requiredPath && (
        <p className="break-all text-muted-foreground">
          {text("Required file", "目标文件")}: {requiredPath}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-semibold">
        <a
          className="text-primary hover:underline"
          href={SMPLX_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
        >
          {text("Official download", "官方下载")}
        </a>
        <a
          className="text-primary hover:underline"
          href={SMPLX_LICENSE_URL}
          target="_blank"
          rel="noreferrer"
        >
          {text("License terms", "许可条款")}
        </a>
      </div>
    </aside>
  );
}
