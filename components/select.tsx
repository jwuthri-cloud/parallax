"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

type Option = { value: string; label: string; description?: string };

/** A select-only combobox. Focus stays on the trigger, including inside dialogs. */
export function Select({
  value,
  onValueChange,
  options,
  label,
  id,
  disabled = false,
  className = "",
  showDescription = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly Option[];
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  showDescription?: boolean;
}) {
  const generatedId = useId();
  const listId = `${generatedId}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const expanded = open && !disabled && options.length > 0;
  const activeIndex = Math.min(active, options.length - 1);

  function show(index = Math.max(0, selectedIndex)) {
    search.current = { text: "", time: 0 };
    setActive(index);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onValueChange(option.value);
  }

  useLayoutEffect(() => {
    if (!expanded) return;
    function place() {
      if (!trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const gap = 6;
      const margin = 12;
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const upwards = below < 240 && above > below;
      const width = Math.min(
        Math.max(rect.width, 240),
        window.innerWidth - margin * 2,
      );
      setPosition({
        width,
        left: Math.max(
          margin,
          Math.min(rect.left, window.innerWidth - width - margin),
        ),
        ...(upwards
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
        maxHeight: Math.max(0, Math.min(320, upwards ? above : below)),
      });
    }
    function outside(event: Event) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target))
        setOpen(false);
    }
    function onScroll(event: Event) {
      if (!menu.current?.contains(event.target as Node)) place();
    }
    place();
    const resize = new ResizeObserver(place);
    if (trigger.current) resize.observe(trigger.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const option = menu.current?.children[activeIndex] as
      HTMLElement | undefined;
    const list = menu.current;
    if (!option || !list) return;
    // Scroll only the menu, never the surrounding page or modal.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      list.scrollTop + list.clientHeight
    )
      list.scrollTop =
        option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [expanded, activeIndex, position]);

  return (
    <>
      <button
        ref={trigger}
        id={id || generatedId}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={
          expanded ? `${listId}-${activeIndex}` : undefined
        }
        disabled={disabled || !options.length}
        className={`parallax-select ${showDescription ? "descriptive" : ""} ${className}`}
        onClick={() => (expanded ? setOpen(false) : show())}
        onKeyDown={(event) => {
          const { key } = event;
          if (key === "Tab") {
            setOpen(false);
            return;
          }
          if (key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (
            ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (key === "Home") {
              show(0);
              return;
            }
            if (key === "End") {
              show(options.length - 1);
              return;
            }
            if (!expanded) {
              show();
              return;
            }
            if (key === "Enter" || key === " ") {
              choose(activeIndex);
              return;
            }
            setActive(
              Math.max(
                0,
                Math.min(
                  options.length - 1,
                  activeIndex + (key === "ArrowDown" ? 1 : -1),
                ),
              ),
            );
            return;
          }
          if (
            key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const now = Date.now();
            const text =
              (now - search.current.time < 600 ? search.current.text : "") +
              key.toLowerCase();
            search.current = { text, time: now };
            // Repeating a letter cycles through matching options.
            const query = [...text].every((char) => char === text[0])
              ? text[0]
              : text;
            const start = expanded ? activeIndex : Math.max(0, selectedIndex);
            const indexes = options.map(
              (_, offset) =>
                (start + offset + (query.length === 1 ? 1 : 0)) %
                options.length,
            );
            const match = indexes.find((index) =>
              options[index].label.toLowerCase().startsWith(query),
            );
            if (match !== undefined) {
              setActive(match);
              setOpen(true);
            }
          }
        }}
      >
        <span className="select-value">
          <span>{selected?.label || "Choose an option"}</span>
          {showDescription && selected?.description && (
            <small>{selected.description}</small>
          )}
        </span>
        <ChevronDown size={14} className="select-chevron" aria-hidden="true" />
      </button>
      {expanded &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={label}
            className="select-menu"
            style={position}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={`select-option ${index === activeIndex ? "highlighted" : ""}`}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => {
                  if (event.pointerType === "mouse") event.preventDefault();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(index);
                }}
              >
                <span>
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
                {option.value === value && (
                  <Check size={14} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>,
          // Keep the popup inside the active dialog's accessibility boundary.
          trigger.current?.closest('[role="dialog"]') || document.body,
        )}
    </>
  );
}
