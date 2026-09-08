"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { searchLocalVocabulary } from "@/lib/vocabulary";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** The comma/newline-delimited token immediately before the cursor. */
function currentToken(value: string, cursor: number) {
  const before = value.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(","), before.lastIndexOf("\n")) + 1;
  return { token: before.slice(start).trim(), start };
}

type Props = {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
};

type AutocompleteSuggestion = {
  tag: string;
  translation?: string;
  count?: number;
};
/** Textarea with inline NovelAI tag autocomplete (suggestTags). */
export function TagTextarea({ id, value, onChange, placeholder, className, "aria-label": ariaLabel }: Props) {
  const client = useStore((s) => s.client);
  const listId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  // -1 means "nothing chosen yet". This used to initialise to 0, so the top suggestion was
  // pre-selected the instant the popover opened — and Enter, the newline key in a multi-line
  // prompt, silently replaced the token you were typing with a tag you never picked. Enter and Tab
  // now pass through to native behaviour until you explicitly arrow into the list.
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const tokenStart = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const querySequence = useRef(0);
  // Circuit breaker for suggestTags: when the API host is unreachable every keystroke fires a
  // request that hangs until timeout (and nekoai-js retries on 5xx). After three consecutive
  // failures, stop querying until the streak resets on a success — the popover is useless
  // anyway while the host is down, and the user's typing shouldn't stack hung requests.
  const failStreak = useRef(0);

  /**
   * Grow with wrapped content, then hand scrolling back to the textarea at its CSS max-height.
   * Measuring from `auto` is what lets the field shrink again after reset/delete, while the small
   * border correction keeps a border-box textarea from gaining a permanent 2px scrollbar.
   */
  const resizeToContent = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // DesktopWorkspace keeps Studio mounted with display:none while another
    // workspace is active. Measuring then reports a zero scrollHeight and used
    // to collapse every prompt field; growing them again on return made scroll
    // anchoring jump the Basic panel down to the scene prompt.
    if (el.getClientRects().length === 0) return;
    el.style.height = "auto";
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + borders}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
  }, []);

  // Layout effect avoids a one-frame flash at the old height when settings are restored, reset, or
  // replaced from the gallery. Normal input and paste flow through the same value update.
  useLayoutEffect(() => {
    resizeToContent();
  }, [value, resizeToContent]);

  // Wrapped line count changes with the drawer/viewport width even when the value does not.
  useEffect(() => {
    window.addEventListener("resize", resizeToContent);
    return () => window.removeEventListener("resize", resizeToContent);
  }, [resizeToContent]);

  const query = (val: string, cursor: number) => {
    const { token, start } = currentToken(val, cursor);
    tokenStart.current = start;
    if (timer.current) clearTimeout(timer.current);
    const sequence = ++querySequence.current;
    if (token.length < 2) {
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      let merged: AutocompleteSuggestion[] = [];
      try {
        const local = await searchLocalVocabulary(token, 8);
        if (sequence !== querySequence.current) return;
        merged = local.map((item) => ({ tag: item.name, translation: item.translation, count: item.hot }));
        setSuggestions(merged);
        setActive(-1);
        setOpen(merged.length > 0);
      } catch {
        // The local service may still be starting; online suggestions remain available below.
      }
      if (!client || failStreak.current >= 3) {
        if (!merged.length) setOpen(false);
        return;
      }
      try {
        const online = await client.suggestTags(token);
        if (sequence !== querySequence.current) return;
        failStreak.current = 0;
        const byName = new Map(merged.map((item) => [item.tag.toLocaleLowerCase(), item]));
        online.forEach((item) => {
          const key = item.tag.toLocaleLowerCase();
          if (!byName.has(key)) byName.set(key, { tag: item.tag, count: item.count });
        });
        merged = [...byName.values()].slice(0, 8);
        setSuggestions(merged);
        setActive(-1);
        setOpen(merged.length > 0);
      } catch {
        failStreak.current += 1;
        if (!merged.length) setOpen(false);
      }
    }, 180);
  };

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const accept = (s: AutocompleteSuggestion) => {
    const el = ref.current;
    if (!el) return;
    const cursor = el.selectionStart ?? value.length;
    const display = s.tag.replace(/_/g, " ");
    const left = value.slice(0, tokenStart.current).replace(/\s*$/, "");
    const right = value.slice(cursor).replace(/^\s*,?\s*/, "");
    const sep = left === "" ? "" : " ";
    const inserted = `${left}${sep}${display}, `;
    const next = inserted + right;
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inserted.length, inserted.length);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // From -1 this lands on 0 rather than wrapping to the end.
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length : a) - 1);
    } else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
      // Nothing is selected until the user arrows into the list, so Enter still inserts a newline
      // and Tab still moves focus — the popover no longer traps either.
      // Cmd/Ctrl+Enter belongs to the global Generate accelerator.
      if (active < 0) return;
      const chosen = suggestions[active];
      // `suggestions` can be replaced by an in-flight query between the keystroke and this handler.
      if (!chosen) return;
      e.preventDefault();
      accept(chosen);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Textarea
        id={id}
        ref={ref}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        className={cn(
          "max-h-[min(45dvh,28rem)] resize-none overflow-y-hidden",
          "[scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]",
          className,
        )}
        onChange={(e) => {
          onChange(e.target.value);
          query(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && (
        // tabIndex={-1} is load-bearing: `overflow-y-auto` makes this a scrollable container, and
        // Chrome puts those in the tab order. Tab from the prompt landed here instead of the next
        // field, then the popover closed underneath it and dropped focus to <body>. Selection is
        // driven by aria-activedescendant, so the list must never be a tab stop.
        <ul id={listId} role="listbox" tabIndex={-1} className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-[var(--radius-input)] border border-border bg-surface-3 py-1 shadow-xl">
          {suggestions.map((s, i) => (
            <li
              key={s.tag}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(s)}
              className={cn(
                "flex cursor-pointer items-center px-3 py-2 text-left text-[13px]",
                i === active ? "bg-accent/15 text-fg" : "text-fg-2 hover:bg-surface-2",
              )}
            >
              <span className="min-w-0 truncate">
                <span>{s.tag.replace(/_/g, " ")}</span>
                {s.translation && <span className="text-muted">{"\uff08"}{s.translation}{"\uff09"}</span>}
                {typeof s.count === "number" && s.count >= 0 && (
                  <span className="font-[family-name:var(--font-mono)] text-[11px] text-muted">{" - "}{s.count.toLocaleString()}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
