import { useLocation, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, type Transition } from "framer-motion";
import { Check, ChevronDown, Languages } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGE_ABBREVIATIONS,
  LANGUAGE_NAMES,
  LOCALES,
  type Locale,
  localizePath,
  splitLocalePath,
  useLocale,
} from "~/i18n";

const MENU_HIDDEN = { opacity: 0, y: -4 };
const MENU_SHOWN = { opacity: 1, y: 0 };
const MENU_TRANSITION: Transition = { duration: 0.15, ease: "easeOut" };

const ITEM_SELECTOR = '[role="menuitemradio"]';

/** The closest the menu comes to the edge of the screen. */
const VIEWPORT_MARGIN = 8;

/** Which item takes focus when the menu opens: the current language, or an end the arrow key named. */
type OpenFocus = "current" | "first" | "last";

/**
 * Switches the page to the same page in another language, keeping its query and hash so filters
 * and anchors survive. The URL carries the choice, so every link on the new page stays in it.
 *
 * The trigger shows the language abbreviated; the menu names every language in itself. It follows
 * the menu button pattern: arrows move between languages, Escape and outside presses close it.
 */
export function LanguageSelector() {
  const { t } = useTranslation();
  const locale = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [openFocus, setOpenFocus] = useState<OpenFocus | null>(null);
  const open = openFocus !== null;

  const close = useCallback(() => setOpenFocus(null), []);

  // The menu hangs from the trigger's end, which on a narrow header can push it off the screen.
  useLayoutEffect(() => {
    if (open && menuRef.current) keepInViewport(menuRef.current);
  }, [open]);

  useEffect(() => {
    if (!openFocus) return;
    focusOnOpen(menuItems(menuRef.current), openFocus);
  }, [openFocus]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open, close]);

  const toggle = useCallback(() => setOpenFocus((current) => (current ? null : "current")), []);

  const onTriggerKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpenFocus(event.key === "ArrowDown" ? "first" : "last");
    }
  }, []);

  const onMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const items = menuItems(menuRef.current);
      const index = items.indexOf(document.activeElement as HTMLElement);
      const moveTo = (next: number) => {
        event.preventDefault();
        items[(next + items.length) % items.length]?.focus();
      };
      switch (event.key) {
        case "ArrowDown":
          return moveTo(index + 1);
        case "ArrowUp":
          return moveTo(index - 1);
        case "Home":
          return moveTo(0);
        case "End":
          return moveTo(items.length - 1);
        case " ":
          event.preventDefault();
          items[index]?.click();
          return;
        case "Escape":
          event.preventDefault();
          close();
          triggerRef.current?.focus();
          return;
        case "Tab":
          close();
          return;
      }
    },
    [close],
  );

  const { path } = splitLocalePath(location.pathname);
  const suffix = `${location.searchStr}${location.hash ? `#${location.hash}` : ""}`;

  const choose = useCallback(
    (href: string) => {
      close();
      triggerRef.current?.focus();
      void navigate({ href });
    },
    [close, navigate],
  );

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("languageSelector.current", { language: LANGUAGE_NAMES[locale] })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        className={`-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${open ? "text-foreground" : "text-muted-foreground"}`}
      >
        <Languages size={16} aria-hidden="true" />
        <span className="font-medium tracking-wide">{LANGUAGE_ABBREVIATIONS[locale]}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={t("languageSelector.label")}
            onKeyDown={onMenuKeyDown}
            initial={MENU_HIDDEN}
            animate={MENU_SHOWN}
            exit={MENU_HIDDEN}
            transition={MENU_TRANSITION}
            className="absolute right-0 top-full z-50 mt-2 flex min-w-44 flex-col gap-0.5 rounded-lg border border-border bg-card p-1 shadow-xl shadow-black/40"
          >
            {LOCALES.map((option) => (
              <LanguageOption
                key={option}
                language={option}
                href={`${localizePath(path, option)}${suffix}`}
                checked={option === locale}
                onChoose={choose}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * One language in the menu. It is a real link to the same page in that language, so it can be
 * opened in a new tab; a plain click switches in place.
 */
function LanguageOption({
  language,
  href,
  checked,
  onChoose,
}: {
  language: Locale;
  href: string;
  checked: boolean;
  onChoose: (href: string) => void;
}) {
  const { t } = useTranslation();
  const localName = t(`languageSelector.names.${language}`);
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      onChoose(href);
    },
    [href, onChoose],
  );
  const focusOnHover = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => event.currentTarget.focus(),
    [],
  );
  return (
    <a
      href={href}
      hrefLang={language}
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      onClick={onClick}
      onMouseEnter={focusOnHover}
      className={`flex items-center gap-3 whitespace-nowrap rounded-md px-2.5 py-2 text-sm outline-none transition-colors focus:bg-secondary focus:text-foreground ${checked ? "text-foreground" : "text-muted-foreground"}`}
    >
      <span className="flex flex-col">
        <span lang={language}>{LANGUAGE_NAMES[language]}</span>
        {localName !== LANGUAGE_NAMES[language] && (
          <span className="text-xs text-extra-muted-foreground">{localName}</span>
        )}
      </span>
      <Check
        size={14}
        aria-hidden="true"
        className={`ml-auto shrink-0 ${checked ? "" : "invisible"}`}
      />
    </a>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)] : [];
}

function keepInViewport(menu: HTMLElement) {
  const { left, right } = menu.getBoundingClientRect();
  let shift = 0;
  if (left < VIEWPORT_MARGIN) shift = VIEWPORT_MARGIN - left;
  else if (right > window.innerWidth - VIEWPORT_MARGIN) {
    shift = window.innerWidth - VIEWPORT_MARGIN - right;
  }
  menu.style.translate = `${shift}px 0`;
}

function focusOnOpen(items: HTMLElement[], openFocus: OpenFocus) {
  if (openFocus === "first") items[0]?.focus();
  else if (openFocus === "last") items.at(-1)?.focus();
  else items.find((item) => item.getAttribute("aria-checked") === "true")?.focus();
}
