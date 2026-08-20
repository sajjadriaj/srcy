package main

import (
	"regexp"
	"strconv"
	"strings"
)

// Hunk is one @@ block. Body is kept byte-identical to what git produced —
// it is handed back to `git apply` unmodified, so anything clever done to it
// here is a corruption waiting to happen.
type Hunk struct {
	Header   string // the @@ line
	Body     string // every line after it, newline-terminated
	Func     string // enclosing function, from git's xfuncname; may be empty
	NewStart int    // first line number on the new side
	NewCount int    // how many new-side lines this hunk covers
}

// FileDiff is one file's section of a unified diff.
type FileDiff struct {
	Path   string
	Header string // "diff --git ..." through the last line before the first @@
	Hunks  []Hunk
	Binary bool
}

var hunkRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$`)

// SplitDiff carves a unified diff into files and hunks by moving raw text.
//
// Hunk ends are found by consuming exactly the line counts declared in the
// @@ header, never by string-matching for the next boundary. A context line
// that happens to read "diff --git ..." is real and common in documentation
// and test fixtures, and matching on it would silently truncate a hunk.
func SplitDiff(raw string) []FileDiff {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	lines := strings.Split(raw, "\n")
	// A trailing newline yields a final empty element; drop it so it does not
	// become a spurious body line.
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	var files []FileDiff
	i := 0
	for i < len(lines) {
		if !strings.HasPrefix(lines[i], "diff --git ") {
			i++ // preamble or trailing junk
			continue
		}
		f := FileDiff{Path: pathFromHeader(lines[i])}
		var header []string
		header = append(header, lines[i])
		i++
		// Header runs until the first hunk or the next file.
		for i < len(lines) &&
			!strings.HasPrefix(lines[i], "@@ ") &&
			!strings.HasPrefix(lines[i], "diff --git ") {
			if strings.HasPrefix(lines[i], "Binary files ") ||
				strings.HasPrefix(lines[i], "GIT binary patch") {
				f.Binary = true
			}
			header = append(header, lines[i])
			i++
		}
		f.Header = strings.Join(header, "\n") + "\n"

		for i < len(lines) && strings.HasPrefix(lines[i], "@@ ") {
			h, next := readHunk(lines, i)
			f.Hunks = append(f.Hunks, h)
			i = next
		}
		files = append(files, f)
	}
	return files
}

// readHunk consumes one hunk starting at lines[start], which must be an @@
// line, and returns it plus the index of the line after it.
func readHunk(lines []string, start int) (Hunk, int) {
	m := hunkRe.FindStringSubmatch(lines[start])
	h := Hunk{Header: lines[start] + "\n"}
	oldLeft, newLeft := 0, 0
	if m != nil {
		oldLeft = countOr1(m[2])
		h.NewStart = atoi(m[3])
		newLeft = countOr1(m[4])
		h.NewCount = newLeft
		h.Func = strings.TrimSpace(m[5])
	}

	var body []string
	i := start + 1
	for i < len(lines) && (oldLeft > 0 || newLeft > 0) {
		l := lines[i]
		switch {
		case strings.HasPrefix(l, `\`): // "\ No newline at end of file"
			// Belongs to the preceding line; consumes no budget.
		case strings.HasPrefix(l, "-"):
			oldLeft--
		case strings.HasPrefix(l, "+"):
			newLeft--
		default: // context line, or an empty line meaning empty context
			oldLeft--
			newLeft--
		}
		body = append(body, l)
		i++
	}
	// A trailing no-newline marker sits outside the line budget.
	if i < len(lines) && strings.HasPrefix(lines[i], `\`) {
		body = append(body, lines[i])
		i++
	}
	if len(body) > 0 {
		h.Body = strings.Join(body, "\n") + "\n"
	}
	return h, i
}

// BuildPatch reassembles the selected hunks into a patch for `git apply`.
// Files with no selected hunk are omitted entirely; a selected binary file
// keeps its whole section, because there is nothing in it to select.
func BuildPatch(files []FileDiff, selected func(fi, hi int) bool) string {
	var b strings.Builder
	for fi, f := range files {
		if f.Binary {
			if selected(fi, 0) {
				b.WriteString(f.Header)
			}
			continue
		}
		var kept []Hunk
		for hi, h := range f.Hunks {
			if selected(fi, hi) {
				kept = append(kept, h)
			}
		}
		if len(kept) == 0 {
			continue
		}
		b.WriteString(f.Header)
		for _, h := range kept {
			b.WriteString(h.Header)
			b.WriteString(h.Body)
		}
	}
	return b.String()
}

// pathFromHeader pulls the new-side path out of `diff --git a/x b/x`.
func pathFromHeader(line string) string {
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return ""
	}
	return strings.TrimPrefix(fields[3], "b/")
}

func countOr1(s string) int {
	if s == "" {
		return 1 // "@@ -3 +3 @@" means a single line
	}
	return atoi(s)
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
