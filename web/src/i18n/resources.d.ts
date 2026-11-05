/**
 * Type injection (spec 008 D2 / SC-002): the base dictionary's keys become the
 * compile-time key set. `t("chat.sendx")` is a type error; a locale missing a
 * key fails typecheck in that locale's file.
 */
import "i18next";
import type { en } from "./locales/en";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
    keySeparator: false;
    nsSeparator: false;
    returnNull: false;
  }
}
