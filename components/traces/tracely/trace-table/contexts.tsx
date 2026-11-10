"use client";

import { createContext } from "react";

// Parallax change: Tracely's contexts carried evaluation-run, live-score, rolling-summary and
// multi-select state; Parallax has none of those features, so only the shared constants remain.

// Control cells the table always renders, in order: chevron · copy. The header, the body rows and
// every colSpan all count off this ONE constant.
export const CTRL_CELLS = 2;

/** How the table names and opens Parallax experiments (the C-row Experiment column). */
export type ExperimentLinks = {
  title: (id: string) => string | undefined;
  open: (id: string) => void;
};
export const ExperimentContext = createContext<ExperimentLinks>({
  title: () => undefined,
  open: () => {},
});
