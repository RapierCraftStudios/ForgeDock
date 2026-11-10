// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Animation frame of the splash; -1 when hidden. */
export type Frame = number

declare module 'claude-code' {
  interface PluginState {
    'forgedock-splash': { frame: Frame }
  }
}
