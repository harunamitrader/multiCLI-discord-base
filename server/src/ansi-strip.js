/**
 * ANSI escape code stripper.
 * Converts PTY raw output to plain text for Chat/Discord/DB.
 *
 * Handles:
 *   - CSI sequences: \x1b[ ... letter (including private params like ?)
 *   - OSC sequences: \x1b] ... BEL or ST
 *   - DCS sequences: \x1b P ... ST
 *   - Simple ESC sequences: \x1b + single char
 *   - C1 control codes (0x80-0x9f)
 *   - Non-printable control characters (except \t and \n)
 */

// OSC sequences: \x1b] content \x07  or  \x1b] content \x1b\\
// Also handles ST terminator (\x1b\)
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// DCS sequences: \x1b P ... \x1b\\
const DCS_RE = /\x1b[P][^\x1b]*(?:\x1b\\)/g;

// CSI sequences: \x1b[ params letter  (params can include ?, numbers, semicolons)
const CSI_RE = /\x1b\[[0-9;?!]*[a-zA-Z]/g;

// Simple ESC + single char (non-[, non-], non-P)
const ESC_RE = /\x1b[^[\]P0-9]/g;

// C1 control codes (0x80-0x9f), rare but possible
const C1_RE = /[\x80-\x9f]/g;

// Non-printable control chars (excluding \t \n \r which we handle separately)
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip ANSI/VT escape codes from PTY output.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  return str
    .replace(OSC_RE, "")
    .replace(DCS_RE, "")
    .replace(CSI_RE, "")
    .replace(ESC_RE, "")
    .replace(C1_RE, "")
    .replace(CTRL_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
