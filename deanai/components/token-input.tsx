"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { hasNovelAITokenFormat, normalizeNovelAIToken } from "@/lib/nai/token";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "onPaste"> & {
  value: string;
  onValueChange: (value: string) => void;
  official?: boolean;
};

export function TokenInput({ value, onValueChange, official = true, className = "", ...props }: Props) {
  const [visible, setVisible] = useState(false);
  const hintId = useId();
  const cleaned = official ? normalizeNovelAIToken(value) : value.trim();
  const plausible = hasNovelAITokenFormat(cleaned);
  return <div className="min-w-0">
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} value={value}
        autoComplete="off" autoCapitalize="none" spellCheck={false}
        aria-describedby={[props["aria-describedby"], hintId].filter(Boolean).join(" ")}
        className={className + " pr-12"}
        onChange={(event) => onValueChange(event.target.value)}
        onPaste={(event) => {
          if (!official) return;
          // Read clipboard text before password inputs silently strip line breaks.
          const pasted = event.clipboardData.getData("text");
          if (!pasted) return;
          event.preventDefault();
          const input = event.currentTarget;
          onValueChange(value.slice(0, input.selectionStart ?? 0)
            + normalizeNovelAIToken(pasted) + value.slice(input.selectionEnd ?? value.length));
        }} />
      <button type="button" aria-label={visible ? "隐藏 Token" : "显示 Token"}
        aria-pressed={visible} onClick={() => setVisible((shown) => !shown)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted hover:text-fg focus-visible:outline focus-visible:outline-accent">
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
    <p id={hintId} className="mt-1.5 text-xs leading-relaxed text-muted" aria-live="polite">
      {official ? <>清理后 {cleaned.length} 个字符 · {plausible ? "已识别 pst- 格式（不代表完整或有效）" : "请粘贴完整 pst- Token，不要粘贴圆点或省略号"}。自动清理引号、Bearer 前缀和空白；字符数可与查询脚本核对。</> : <>已输入 {cleaned.length} 个字符；自定义服务的密钥不进行格式转换。</>}
    </p>
  </div>;
}
