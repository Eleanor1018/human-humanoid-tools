import type { WorkspaceLocale } from "@/workbench/common/workspace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AboutDialogProps {
  open: boolean;
  locale: WorkspaceLocale;
  onOpenChange(open: boolean): void;
}

export function AboutDialog({ open, locale, onOpenChange }: AboutDialogProps) {
  const zh = locale === "zh-CN";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="about-dialog">
        <DialogHeader>
          <DialogTitle id="about-dialog-title">
            Human-Humanoid Tools
          </DialogTitle>
          <DialogDescription>
            {zh
              ? "人形机器人动作重映射与数据集分析工具"
              : "Humanoid motion retargeting and dataset analysis"}
          </DialogDescription>
        </DialogHeader>
        <dl className="about-dialog-details">
          <div>
            <dt>{zh ? "作者与贡献者" : "Authors and contributors"}</dt>
            <dd>jaggerShen {zh ? "与" : "and"} hhtools contributors</dd>
          </div>
          <div>
            <dt>{zh ? "年份" : "Year"}</dt>
            <dd>2026</dd>
          </div>
          <div>
            <dt>{zh ? "源代码" : "Source code"}</dt>
            <dd>
              <a
                href="https://github.com/Roboparty/human-humanoid-tools"
                target="_blank"
                rel="noreferrer"
              >
                github.com/Roboparty/human-humanoid-tools
              </a>
            </dd>
          </div>
          <div>
            <dt>{zh ? "许可证" : "License"}</dt>
            <dd>Apache-2.0</dd>
          </div>
        </dl>
        <section
          className="about-dialog-contact"
          aria-label={zh ? "联系" : "Contact"}
        >
          <h3>{zh ? "联系" : "Contact"}</h3>
          <a href="mailto:shenyaojie@roboparty.com">shenyaojie@roboparty.com</a>
          <a href="mailto:sunlancheng@roboparty.com">
            sunlancheng@roboparty.com
          </a>
        </section>
      </DialogContent>
    </Dialog>
  );
}
