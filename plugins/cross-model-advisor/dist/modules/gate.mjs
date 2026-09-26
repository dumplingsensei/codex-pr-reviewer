#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ignore/index.js
var require_ignore = __commonJS({
  "node_modules/ignore/index.js"(exports, module) {
    function makeArray(subject) {
      return Array.isArray(subject) ? subject : [subject];
    }
    var UNDEFINED = void 0;
    var EMPTY = "";
    var SPACE = " ";
    var ESCAPE = "\\";
    var REGEX_LITERAL_SPECIAL = /[.*+?()[\]{}^$|\\/]/;
    var REGEX_TEST_BLANK_LINE = /^ +$/;
    var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
    var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
    var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
    var REGEX_SPLITALL_CRLF = /\r?\n/g;
    var DOUBLE_SLASH = "//";
    var SLASH_CODE = 47;
    var DOT_CODE = 46;
    var SLASH = "/";
    var TMP_KEY_IGNORE = "node-ignore";
    if (typeof Symbol !== "undefined") {
      TMP_KEY_IGNORE = /* @__PURE__ */ Symbol.for("node-ignore");
    }
    var KEY_IGNORE = TMP_KEY_IGNORE;
    var define = (object, key, value) => {
      Object.defineProperty(object, key, { value });
      return value;
    };
    var RETURN_FALSE = () => false;
    var cleanRangeBackSlash = (slashes) => {
      const { length } = slashes;
      return slashes.slice(0, length - length % 2);
    };
    var POSIX_CLASSES = {
      alnum: "0-9A-Za-z",
      alpha: "A-Za-z",
      blank: " \\t",
      cntrl: "\\x00-\\x1f\\x7f",
      digit: "0-9",
      graph: "!-.0-~",
      lower: "a-z",
      print: " -.0-~",
      punct: "!-.:-@\\[-`{-~",
      // git's `sane-ctype.h` classifies \v and \f as control, not space,
      //   unlike C's `isspace`
      space: " \\t\\n\\r",
      upper: "A-Z",
      xdigit: "0-9A-Fa-f"
    };
    var CLASS_MEMBERS_TO_ESCAPE = "\\]^-[";
    var escapeMember = (char) => CLASS_MEMBERS_TO_ESCAPE.indexOf(char) < 0 ? char : ESCAPE + char;
    var NON_SLASH = "(?!\\/)";
    var classSource = (negated, body) => {
      if (negated) {
        return `[^\\/${body}]`;
      }
      const source = `[${body}]`;
      return new RegExp(source).test("/") ? NON_SLASH + source : source;
    };
    var scanBracket = (pattern, start) => {
      const { length } = pattern;
      let index = start + 1;
      let negated = EMPTY;
      const lead = pattern[index];
      if (lead === "!" || lead === "^") {
        negated = "^";
        index++;
      }
      let body = EMPTY;
      let prev = EMPTY;
      for (; ; ) {
        const char = pattern[index];
        if (char === UNDEFINED) {
          return null;
        }
        if (char === ESCAPE) {
          const escaped = pattern[index + 1];
          if (escaped === UNDEFINED) {
            return null;
          }
          body += escapeMember(escaped);
          prev = escaped;
          index++;
        } else if (char === "-" && prev && index + 1 < length && pattern[index + 1] !== "]") {
          index++;
          let to = pattern[index];
          if (to === ESCAPE) {
            to = pattern[index += 1];
          }
          if (prev <= to) {
            body += `-${escapeMember(to)}`;
          }
          prev = EMPTY;
        } else if (char === "[" && pattern[index + 1] === ":") {
          const nameStart = index + 2;
          let end = nameStart;
          while (end < length && pattern[end] !== "]") {
            end++;
          }
          if (end === length) {
            return null;
          }
          if (end > nameStart && pattern[end - 1] === ":") {
            const expanded = POSIX_CLASSES[pattern.slice(nameStart, end - 1)];
            if (expanded === UNDEFINED) {
              return null;
            }
            body += expanded;
            prev = EMPTY;
            index = end;
          } else {
            body += escapeMember("[");
            prev = "[";
            index = nameStart - 2;
          }
        } else {
          body += escapeMember(char);
          prev = char;
        }
        index++;
        if (pattern[index] === "]") {
          return {
            end: index,
            source: classSource(negated, body)
          };
        }
      }
    };
    var NEVER_MATCH = "[]";
    var PLACEHOLDER = "\0";
    var REGEX_RESTORE_PLACEHOLDER = new RegExp(
      `${PLACEHOLDER}(\\d+)${PLACEHOLDER}`,
      "g"
    );
    var TRAILING_WILDCARD = "";
    var extractBrackets = (pattern) => {
      const sources = [];
      const hold = (source) => `${PLACEHOLDER}${sources.push(source) - 1}${PLACEHOLDER}`;
      const { length } = pattern;
      let out = EMPTY;
      let index = 0;
      while (index < length) {
        const char = pattern[index];
        if (char === ESCAPE) {
          const escaped = pattern[index + 1];
          if (escaped === "*" || escaped === "[" || escaped === SPACE || escaped === ESCAPE) {
            out += pattern.slice(index, index + 2);
          } else {
            out += hold(
              REGEX_LITERAL_SPECIAL.test(escaped) ? ESCAPE + escaped : escaped
            );
          }
          index += 2;
        } else if (char === PLACEHOLDER) {
          out += hold(`[${PLACEHOLDER}]`);
          index++;
        } else if (char === "[") {
          const scanned = scanBracket(pattern, index);
          if (scanned === null) {
            out += hold(NEVER_MATCH);
            index = length;
          } else {
            out += hold(scanned.source);
            index = scanned.end + 1;
          }
        } else {
          out += char;
          index++;
        }
      }
      return {
        source: out,
        sources
      };
    };
    var DIRECT = null;
    var REGEX_INNER_SLASH = /\/(?!$)/;
    var REPLACERS = [
      [
        // Remove BOM
        // TODO:
        // Other similar zero-width characters?
        /^\uFEFF/,
        () => EMPTY,
        "\uFEFF"
      ],
      [
        // A trailing line terminator, left on when a whole file's contents are
        //   added as one pattern rather than split into lines. git never sees one
        //   -- it reads a `.gitignore` line by line -- so it is not part of the
        //   pattern and is dropped here, apart from the trailing-space trimming,
        //   which follows git in touching spaces and nothing else.
        /[\r\n]+$/,
        () => EMPTY
      ],
      // > Trailing spaces are ignored unless they are quoted with backslash ("\")
      [
        // Only spaces, never tabs or other whitespace: git trims a trailing run
        //   of `' '` and nothing else (dir.c, `trim_trailing_spaces`, a single
        //   `case ' '`), so a pattern ending in a tab keeps it as a literal.
        // (a\ ) -> (a )
        // (a  ) -> (a)
        // (a ) -> (a)
        // (a \ ) -> (a  )
        /((?:\\\\)*?)(\\? +)$/,
        (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
      ],
      // Replace (\ ) with ' '
      // Only a space: an escaped tab or other whitespace is already a literal by
      //   the time it reaches here, and a bare tab must be left as one, not turned
      //   into a space.
      // (\ ) -> ' '
      // (\\ ) -> '\\ '
      // (\\\ ) -> '\\ '
      [
        /(\\+?) /g,
        (_, m1) => {
          const { length } = m1;
          return m1.slice(0, length - length % 2) + SPACE;
        }
      ],
      // Escape metacharacters
      // which is written down by users but means special for regular expressions.
      // > There are 12 characters with special meanings:
      // > - the backslash \,
      // > - the caret ^,
      // > - the dollar sign $,
      // > - the period or dot .,
      // > - the vertical bar or pipe symbol |,
      // > - the question mark ?,
      // > - the asterisk or star *,
      // > - the plus sign +,
      // > - the opening parenthesis (,
      // > - the closing parenthesis ),
      // > - and the opening square bracket [,
      // > - the opening curly brace {,
      // > These special characters are often called "metacharacters".
      [
        /[\\$.|*+(){^]/g,
        (match) => `\\${match}`
      ],
      [
        // > a question mark (?) matches a single character
        /(?!\\)\?/g,
        () => "[^/]",
        "?"
      ],
      // leading slash
      [
        // > A leading slash matches the beginning of the pathname.
        // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
        // A leading slash matches the beginning of the pathname
        /^\//,
        () => "^",
        SLASH
      ],
      // replace special metacharacter slash after the leading slash
      [
        /\//g,
        () => "\\/",
        SLASH
      ],
      [
        // > A leading "**" followed by a slash means match in all directories.
        // > For example, "**/foo" matches file or directory "foo" anywhere,
        // > the same as pattern "foo".
        // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
        // >   under directory "foo".
        // Notice that the '*'s have been replaced as '\\*'
        /^\^*(?:\\\*\\\*\\\/)+/,
        // '**/foo' <-> 'foo'
        () => "^(?:.*\\/)?",
        "*"
      ],
      // starting
      [
        // there will be no leading '/'
        //   (which has been replaced by section "leading slash")
        // If starts with '**', adding a '^' to the regular expression also works
        DIRECT,
        (source, pattern) => {
          if (!source || source[0] === "^") {
            return source;
          }
          const anchor = !REGEX_INNER_SLASH.test(pattern) ? "(?:^|\\/)" : "^";
          return anchor + source;
        }
      ],
      // two globstars
      [
        // Use lookahead assertions so that we could match more than one `'/**'`
        /\\\/\\\*\\\*(?=\\\/|$)/g,
        // Zero, one or several directories
        // should not use '*', or it will be replaced by the next replacer
        // Check if it is not the last `'/**'`
        (_, index, str) => index + 6 < str.length ? str.slice(index + 6) === "\\/" ? "(?:\\/[^\\/]+)+" : "(?:\\/[^\\/]+)*" : "\\/.+",
        "*"
      ],
      // normal intermediate wildcards
      [
        // Never replace escaped '*'
        // ignore rule '\*' will match the path '*'
        // 'abc.*/' -> go
        // 'abc.*'  -> skip this rule,
        //    coz trailing single wildcard will be handed by [trailing wildcard]
        /(^|[^\\]+)(\\\*)+(?=.+)/g,
        // '*.js' matches '.js'
        // '*.js' doesn't match 'abc'
        (_, p1, p2) => {
          const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
          return p1 + unescaped;
        },
        "*"
      ],
      // trailing wildcard, held apart from a literal star
      [
        // The step above leaves a trailing `*` alone, so a single `\*` is all that
        //   can be left at the end here. Whether it is a wildcard or a literal
        //   turns on the backslashes the user put in front of it: the escaper has
        //   since doubled every one, so what stands here is those `2N` doubled
        //   backslashes and then the star's own escape. An even number of the
        //   original `N` leaves the star unescaped -- a wildcard -- and an odd
        //   number escapes it -- a literal. This runs while the two are still
        //   distinct, before the unescape steps below collapse the literal onto
        //   the very `\*` a wildcard leaves behind.
        /(^|[^\\])((?:\\\\)*)\\\*$/,
        (match, p1, p2) => (
          // `p2` holds the doubled user backslashes; half of them is `N`.
          p2.length / 2 % 2 === 0 ? p1 + p2 + TRAILING_WILDCARD : match
        ),
        "*"
      ],
      [
        // unescape, revert step 3 except for back slash
        // For example, if a user escape a '\\*',
        // after step 3, the result will be '\\\\\\*'
        /\\\\\\(?=[$.|*+(){^])/g,
        () => ESCAPE,
        ESCAPE + ESCAPE
      ],
      [
        // '\\\\' -> '\\'
        /\\\\/g,
        () => ESCAPE,
        ESCAPE + ESCAPE
      ],
      [
        // Every real bracket expression -- POSIX classes included -- has already
        //   been held aside by `extractBrackets`, so the only `[` left in the
        //   pattern is an escaped, literal one.
        // `\` is escaped by step 3
        /\\\[([^\]/]*?)(\\*)($|\])/g,
        // '\\[bar]' -> '\\\\[bar\\]'
        (match, range, endEscape, close) => `\\[${range}${cleanRangeBackSlash(endEscape)}${close}`,
        "["
      ],
      // ending
      [
        // 'js' will not match 'js.'
        // 'ab' will not match 'abc'
        DIRECT,
        // WTF!
        // https://git-scm.com/docs/gitignore
        // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
        // which re-fixes #24, #38
        // > If there is a separator at the end of the pattern then the pattern
        // > will only match directories, otherwise the pattern can match both
        // > files and directories.
        // 'js*' will not match 'a.js'
        // 'js/' will not match 'a.js'
        // 'js' will match 'a.js' and 'a.js/'
        (source) => {
          const last = source[source.length - 1];
          if (!last || last === TRAILING_WILDCARD) {
            return source;
          }
          return last === SLASH ? `${source}$` : `${source}(?=$|\\/$)`;
        }
      ]
    ];
    var REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\uE000$/;
    var MODE_IGNORE = "regex";
    var MODE_CHECK_IGNORE = "checkRegex";
    var UNDERSCORE = "_";
    var TRAILING_WILD_CARD_REPLACERS = {
      [MODE_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      },
      [MODE_CHECK_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      }
    };
    var WILDCARD = "[^\\/]*";
    var pinWildcards = (source) => {
      if (source.indexOf(WILDCARD) < 0) {
        return source;
      }
      const tokens = [];
      const { length } = source;
      let index = 0;
      while (index < length) {
        const char = source[index];
        if (source.startsWith(WILDCARD, index)) {
          tokens.push({ wildcard: true });
          index += WILDCARD.length;
        } else if (char === "[") {
          let end = index + 1;
          if (source[end] === "^") {
            end++;
          }
          if (source[end] === "]") {
            end++;
          }
          while (end < length && source[end] !== "]") {
            end += source[end] === ESCAPE ? 2 : 1;
          }
          end++;
          tokens.push({ single: source.slice(index, end) });
          index = end;
        } else if (char === ESCAPE) {
          tokens.push({ single: source.slice(index, index + 2) });
          index += 2;
        } else if (char === "(") {
          let depth = 0;
          let end = index;
          do {
            if (source[end] === ESCAPE) {
              end++;
            } else if (source[end] === "(") {
              depth++;
            } else if (source[end] === ")") {
              depth--;
            }
            end++;
          } while (end < length && depth > 0);
          if ("*+?".indexOf(source[end]) >= 0) {
            end++;
          }
          tokens.push({ boundary: source.slice(index, end) });
          index = end;
        } else if (char === "^" || char === "$") {
          tokens.push({ boundary: char });
          index++;
        } else {
          tokens.push({ single: char });
          index++;
        }
      }
      let out = EMPTY;
      let run = [];
      const flush = () => {
        let lastWildcard;
        run.forEach((token, at) => {
          if (token.wildcard) {
            lastWildcard = at;
          }
        });
        run.forEach((token, at) => {
          if (!token.wildcard) {
            out += token.single;
            return;
          }
          out += at === lastWildcard ? WILDCARD : `(?:(?!${run[at + 1].single})[^\\/])*`;
        });
        run = [];
      };
      tokens.forEach((token) => {
        if (token.boundary === void 0) {
          run.push(token);
          return;
        }
        flush();
        out += token.boundary;
      });
      flush();
      return out;
    };
    var makeRegexPrefix = (pattern) => {
      const { source, sources } = extractBrackets(pattern);
      const replaced = REPLACERS.reduce(
        // A pass whose matcher finds nothing hands back the very string it was
        //   given, so asking first costs a search and saves a rewrite. Ten of the
        //   fifteen passes never fire for a typical .gitignore line, and between
        //   them they were 45% of this chain.
        (prev, [matcher, replacer, required]) => {
          if (matcher === DIRECT) {
            return replacer(prev, pattern);
          }
          if (required !== UNDEFINED && prev.indexOf(required) < 0) {
            return prev;
          }
          return matcher.test(prev) ? prev.replace(matcher, replacer.bind(pattern)) : prev;
        },
        source
      );
      return sources.length ? replaced.replace(
        REGEX_RESTORE_PLACEHOLDER,
        (match, index) => sources[index]
      ) : replaced;
    };
    var matchesBasename = (body) => {
      const index = body.indexOf(SLASH);
      return index < 0 || index === body.length - 1;
    };
    var basenameOf = (path2) => {
      const end = path2.length - 1;
      const index = path2.lastIndexOf(
        SLASH,
        path2[end] === SLASH ? end - 1 : end
      );
      return index < 0 ? path2 : path2.slice(index + 1);
    };
    var parentOf = (path2) => {
      if (path2.charCodeAt(0) === SLASH_CODE || path2.indexOf(DOUBLE_SLASH) >= 0) {
        const slices = path2.split(SLASH).filter(Boolean);
        slices.pop();
        return slices.length ? slices.join(SLASH) + SLASH : EMPTY;
      }
      const end = path2.length - 1;
      const cut = path2.lastIndexOf(
        SLASH,
        path2.charCodeAt(end) === SLASH_CODE ? end - 1 : end
      );
      return cut < 0 ? EMPTY : path2.slice(0, cut + 1);
    };
    var isString = (subject) => typeof subject === "string";
    var checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
    var splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);
    var IgnoreRule = class {
      constructor(pattern, mark, body, ignoreCase, negative, prefix) {
        this.pattern = pattern;
        this.mark = mark;
        this.negative = negative;
        define(this, "body", body);
        define(this, "ignoreCase", ignoreCase);
        define(this, "regexPrefix", prefix);
      }
      // Worked out on first use and kept behind an own property, the way `regex`
      //   caches itself in `_regex`. Deciding it in the constructor instead would
      //   add a fourth `defineProperty` to every rule ever built, which cost 4% of
      //   every compile -- including the compiles of rules that are never matched
      //   against anything.
      get _basenameOnly() {
        return define(this, "_basenameOnly", matchesBasename(this.body));
      }
      get regex() {
        const key = UNDERSCORE + MODE_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_IGNORE, key);
      }
      get checkRegex() {
        const key = UNDERSCORE + MODE_CHECK_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_CHECK_IGNORE, key);
      }
      _make(mode, key) {
        const str = pinWildcards(this.regexPrefix.replace(
          REGEX_REPLACE_TRAILING_WILDCARD,
          // It does not need to bind pattern
          TRAILING_WILD_CARD_REPLACERS[mode]
        ));
        const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
        return define(this, key, regex);
      }
    };
    var createRule = ({
      pattern,
      mark
    }, ignoreCase) => {
      let negative = false;
      let body = pattern;
      if (body.indexOf("!") === 0) {
        negative = true;
        body = body.substr(1);
      }
      body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
      const regexPrefix = makeRegexPrefix(body);
      return new IgnoreRule(
        pattern,
        mark,
        body,
        ignoreCase,
        negative,
        regexPrefix
      );
    };
    var RuleManager = class {
      constructor(ignoreCase) {
        this._ignoreCase = ignoreCase;
        this._rules = [];
        this._basenameCount = 0;
      }
      _add(pattern) {
        if (pattern && pattern[KEY_IGNORE]) {
          this._rules = this._rules.concat(pattern._rules._rules);
          this._basenameCount += pattern._rules._basenameCount;
          this._added = true;
          return;
        }
        if (isString(pattern)) {
          pattern = {
            pattern
          };
        }
        if (checkPattern(pattern.pattern)) {
          const rule = createRule(pattern, this._ignoreCase);
          this._added = true;
          this._rules.push(rule);
          if (matchesBasename(rule.body)) {
            this._basenameCount++;
          }
        }
      }
      // @param {Array<string> | string | Ignore} pattern
      add(pattern) {
        this._added = false;
        makeArray(
          isString(pattern) ? splitPattern(pattern) : pattern
        ).forEach(this._add, this);
        return this._added;
      }
      // Test one single path without recursively checking parent directories
      //
      // - checkUnignored `boolean` whether should check if the path is unignored,
      //   setting `checkUnignored` to `false` could reduce additional
      //   path matching.
      // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`
      // @returns {TestResult} true if a file is ignored
      test(path2, checkUnignored, mode) {
        let ignored = false;
        let unignored = false;
        let matchedRule;
        const rules = this._rules;
        const { length } = rules;
        const shortcut = this._basenameCount * 2 >= length;
        const basename = shortcut ? basenameOf(path2) : path2;
        for (let index = 0; index < length; index++) {
          const rule = rules[index];
          const { negative } = rule;
          const skip = unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored;
          if (!skip && rule[mode].test(
            shortcut && rule._basenameOnly ? basename : path2
          )) {
            ignored = !negative;
            unignored = negative;
            matchedRule = negative ? UNDEFINED : rule;
          }
        }
        const ret = {
          ignored,
          unignored
        };
        if (matchedRule) {
          ret.rule = matchedRule;
        }
        return ret;
      }
    };
    var throwError = (message, Ctor) => {
      throw new Ctor(message);
    };
    var checkPath = (path2, originalPath, doThrow) => {
      if (!isString(path2)) {
        return doThrow(
          `path must be a string, but got \`${originalPath}\``,
          TypeError
        );
      }
      if (!path2) {
        return doThrow(`path must not be empty`, TypeError);
      }
      if (checkPath.isNotRelative(path2)) {
        const r = "`path.relative()`d";
        return doThrow(
          `path should be a ${r} string, but got "${originalPath}"`,
          RangeError
        );
      }
      return true;
    };
    var isNotRelative = (path2) => {
      const first = path2.charCodeAt(0);
      if (first === SLASH_CODE) {
        return true;
      }
      if (first !== DOT_CODE) {
        return false;
      }
      if (path2.length === 1) {
        return true;
      }
      const second = path2.charCodeAt(1);
      if (second === SLASH_CODE) {
        return true;
      }
      if (second !== DOT_CODE) {
        return false;
      }
      return path2.length === 2 || path2.charCodeAt(2) === SLASH_CODE;
    };
    checkPath.isNotRelative = isNotRelative;
    checkPath.convert = (p) => p;
    var Ignore = class {
      constructor({
        ignorecase = true,
        ignoreCase = ignorecase,
        allowRelativePaths = false
      } = {}) {
        define(this, KEY_IGNORE, true);
        this._rules = new RuleManager(ignoreCase);
        this._strictPathCheck = !allowRelativePaths;
        this._initCache();
      }
      _initCache() {
        this._ignoreCache = /* @__PURE__ */ Object.create(null);
        this._testCache = /* @__PURE__ */ Object.create(null);
      }
      add(pattern) {
        if (this._rules.add(pattern)) {
          this._initCache();
        }
        return this;
      }
      // legacy
      addPattern(pattern) {
        return this.add(pattern);
      }
      // @returns {TestResult}
      _test(originalPath, cache, checkUnignored) {
        const path2 = originalPath && checkPath.convert(originalPath);
        checkPath(
          path2,
          originalPath,
          this._strictPathCheck ? throwError : RETURN_FALSE
        );
        return this._t(path2, cache, checkUnignored);
      }
      checkIgnore(path2) {
        if (path2.charCodeAt(path2.length - 1) !== SLASH_CODE) {
          return this.test(path2);
        }
        const parentPath = parentOf(path2);
        if (parentPath) {
          const parent = this._t(parentPath, this._testCache, true);
          if (parent.ignored) {
            return parent;
          }
        }
        return this._rules.test(path2, false, MODE_CHECK_IGNORE);
      }
      _t(path2, cache, checkUnignored) {
        if (path2 in cache) {
          return cache[path2];
        }
        const parentPath = parentOf(path2);
        const parent = parentPath ? this._t(parentPath, cache, checkUnignored) : UNDEFINED;
        return cache[path2] = parent && parent.ignored ? parent : this._rules.test(path2, checkUnignored, MODE_IGNORE);
      }
      ignores(path2) {
        return this._test(path2, this._ignoreCache, false).ignored;
      }
      createFilter() {
        return (path2) => !this.ignores(path2);
      }
      filter(paths) {
        return makeArray(paths).filter(this.createFilter());
      }
      // @returns {TestResult}
      test(path2) {
        return this._test(path2, this._testCache, true);
      }
    };
    var factory = (options) => new Ignore(options);
    var isPathValid = (path2) => checkPath(path2 && checkPath.convert(path2), path2, RETURN_FALSE);
    var setupWindows = () => {
      const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
      checkPath.convert = makePosix;
      const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
      checkPath.isNotRelative = (path2) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path2) || isNotRelative(path2);
    };
    if (
      // Detect `process` so that it can run in browsers.
      typeof process !== "undefined" && process.platform === "win32"
    ) {
      setupWindows();
    }
    module.exports = factory;
    factory.default = factory;
    module.exports.isPathValid = isPathValid;
    define(module.exports, /* @__PURE__ */ Symbol.for("setupWindows"), setupWindows);
  }
});

// ../../plugins/cross-model-advisor/src/gate.mjs
var import_ignore = __toESM(require_ignore(), 1);
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewApi, validateApi } from "./backends/api.mjs";
import { configFilePath, loadConfig, runtimeErrors, validateRoot } from "./config.mjs";
import { advisorSystemPrompt } from "./prompt.mjs";
import { gitIgnoredPaths, gitTopLevel, reviewBaseTree, snapshotTree, turnDiff } from "./snapshot.mjs";
import { createReviewTools, normalizeFinding } from "./tools.mjs";
import {
  MAX_FINDINGS_PER_REVIEW,
  MAX_REASON_CHARS,
  MAX_STDIN_BYTES,
  SESSION_RETENTION_MS,
  SEVERITY_ORDER,
  STOP_REVIEW_BUDGET_MS,
  USER_SUMMARY_CHARS,
  USER_TEXT_CAP,
  WAKE_MARKER
} from "./session/constants.mjs";
import { createErrorLog } from "./session/errors.mjs";
import {
  ensurePrivateDir,
  explicitPluginData,
  readIdentity,
  sessionDir,
  statePath,
  validateSessionId
} from "./session/paths.mjs";
import { resolveSecrets, sanitizeText, secretNamesFromSnapshot, truncateLabeled } from "./session/sanitize.mjs";
import { loadState, takeNotices, updateState } from "./session/state.mjs";
var ADVISE_WAIT_MS = 6e4;
var MAX_ADVISE_STOPS = 16;
var MAX_NOTICES = 16;
var USAGE = "usage: gate.mjs stop | advise | on|doctor --plugin-data <path> | review --plugin-data <path> [--base <ref>]";
var DISCLOSURE = "At the end of each turn that changes files, the request, Claude's final message, and the git diff (minus excluded paths) go to the configured external providers, which may also read allowed project files. Claude's own credentials are never used.";
var GateError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function credentialDir(env) {
  return path.join(path.dirname(configFilePath(env)), "cross-model-advisor", "credentials");
}
function pluginRootFromHere() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.basename(here);
  if (dir === "src" || dir === "dist") return path.dirname(here);
  if (dir === "modules") return path.dirname(path.dirname(here));
  return here;
}
function mergeUsage(prev, next) {
  if (!next) return prev ?? null;
  const base = prev ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  const cost = base.costUsd === "unknown" || next.costUsd === "unknown" || typeof next.costUsd !== "number" ? "unknown" : base.costUsd + next.costUsd;
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (next.totalTokens ?? 0),
    costUsd: cost
  };
}
function addUsage(state, spent) {
  for (const [name, entry] of Object.entries(spent)) {
    const total = state.advisors[name] ??= { reviews: 0, usage: null, lastError: null };
    total.reviews += entry.reviews;
    total.usage = mergeUsage(total.usage, entry.usage);
    total.lastError = entry.lastError;
  }
}
async function diagnoseAdvisors(config, env, deps) {
  const rows = [];
  for (const advisor of config.advisors) {
    const provider = config.providers[advisor.provider];
    const row = {
      name: advisor.name,
      enabled: advisor.enabled !== false,
      available: false,
      provider: advisor.provider,
      model: advisor.model,
      kind: provider?.kind,
      reasoningEffort: advisor.reasoningEffort ?? "default",
      error: void 0
    };
    if (!row.enabled) {
      rows.push(row);
      continue;
    }
    if (!provider) {
      row.error = "missing provider";
      rows.push(row);
      continue;
    }
    const diagnostic = await deps.validateApi({
      provider,
      advisor,
      env,
      maxOutputTokens: config.limits.maxOutputTokens
    });
    row.available = Boolean(diagnostic?.available);
    if (!row.available) {
      const err = diagnostic?.error;
      row.error = sanitizeText(typeof err === "string" ? err : err?.message || "unavailable");
    }
    rows.push(row);
  }
  return rows;
}
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (typeof payload.session_id === "string" && identity.sessionId && payload.session_id !== identity.sessionId) {
    throw new GateError("identity", "hook session id does not match the Claude session environment");
  }
  if (!identity.sessionId) throw new GateError("identity", "missing Claude session id; run this inside Claude Code");
  if (!identity.pluginData) throw new GateError("identity", "missing plugin data directory");
  let sessionId;
  try {
    sessionId = validateSessionId(identity.sessionId);
  } catch {
    throw new GateError("identity", "invalid Claude session id");
  }
  return { ...identity, sessionId, dir: sessionDir(identity.pluginData, sessionId) };
}
async function pruneSessions(pluginData, liveId, now) {
  const root = path.join(pluginData, "sessions");
  let entries;
  try {
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === liveId) continue;
    const dir = path.join(root, entry.name);
    try {
      const stat = await fsPromises.stat(statePath(dir));
      if (now - stat.mtimeMs > SESSION_RETENTION_MS) await fsPromises.rm(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
function evidenceLine(finding) {
  return finding.evidence.map((item) => {
    const where = item.kind === "file" ? `${item.path}:${item.line}` : item.eventId;
    return `${where} — ${item.detail}`;
  }).join("; ");
}
function formatBlockReason(findings, { round, maxRounds }, intro = defaultBlockIntro(round, maxRounds)) {
  const required = findings.filter((item) => item.severity !== "nit");
  const optional = findings.filter((item) => item.severity === "nit");
  const lines = [intro, ""];
  required.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.severity}] ${item.advisor} (${item.provider}/${item.model})`);
    lines.push(`   ${item.note}`);
    lines.push(`   Evidence: ${evidenceLine(item)}`);
  });
  if (optional.length) {
    lines.push("", "Optional (nits):");
    for (const item of optional) lines.push(`- ${item.advisor}: ${item.note}`);
  }
  return truncateLabeled(sanitizeText(lines.join("\n")), MAX_REASON_CHARS);
}
function defaultBlockIntro(round, maxRounds) {
  return `Cross-model advisors reviewed the changes from this turn (review round ${round} of at most ${maxRounds}) and raised issues. They are other AI models, not the user, and their findings are unverified. Check each one against the code. Fix the ones that are real; for any you judge wrong, say briefly why instead of changing code. Do not make unrelated changes.`;
}
function formatWakeReason(findings, { round, maxRounds }) {
  const intro = `${WAKE_MARKER} Cross-model advisors reviewed an earlier turn in the background (wake ${round} of at most ${maxRounds} before the user's next prompt) and found a blocker. They are other AI models, not the user, and their findings are unverified. If the user has asked for something since, finish that first unless a finding bears on it. Then check each finding against the code as it is now, which may have changed: fix the real ones, and for any you judge wrong or already fixed, say briefly why. Begin your reply by telling the user in one line that a background review flagged these. Do not make unrelated changes.`;
  return formatBlockReason(findings, { round, maxRounds }, intro);
}
function formatBackgroundCard(headline, findings, failed) {
  const lines = [`cross-model-advisor: ${headline}`];
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}
function formatNoticeContext(findings) {
  const lines = [
    "cross-model-advisor: a background review of an earlier turn raised these. They are other AI models' unverified claims, and the user has been shown them. Do not act on them unless they bear on the current request or the user asks."
  ];
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note} (evidence: ${evidenceLine(item)})`);
  return sanitizeText(lines.join("\n"));
}
function formatUserSummary(findings, failed = []) {
  const lines = [`cross-model-advisor: ${findings.length} finding${findings.length === 1 ? "" : "s"} on this turn`];
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}
function formatBlockedSummary(findings, failed, { round, maxRounds }) {
  const count = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  const lines = [`cross-model-advisor: sent Claude back with ${count} (round ${round} of at most ${maxRounds})`];
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}
function formatNotReviewed(why) {
  return `${JSON.stringify({
    systemMessage: truncateLabeled(sanitizeText(`cross-model-advisor: this turn was not reviewed (${why})`), USER_SUMMARY_CHARS)
  })}
`;
}
function notReviewedBy(failed) {
  const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
  return `${failed.length === 1 ? "one advisor" : `${failed.length} advisors`} did not finish reviewing this turn (${detail})`;
}
function formatPartialFailure(failed) {
  return truncateLabeled(sanitizeText(`cross-model-advisor: no findings, but ${notReviewedBy(failed)}`), USER_SUMMARY_CHARS);
}
function collectFindings(results) {
  const seen = /* @__PURE__ */ new Set();
  const all = [];
  for (const result of results) {
    for (const finding of result.findings) {
      const key = normalizeFinding(finding.note);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        advisor: result.name,
        provider: result.provider,
        model: result.model,
        severity: finding.severity,
        note: finding.note,
        evidence: finding.evidence
      });
    }
  }
  return all.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}
async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      out[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return out;
}
function runAdvisors({ runnable, config, spent, session, deps, env, secrets, credDir, ignoredPaths, turnContext, observations, deadline, tree, projectRoot }) {
  const { limits } = config;
  return pool(
    runnable.map((advisor) => async () => {
      const provider = config.providers[advisor.provider];
      const base = { name: advisor.name, provider: advisor.provider, model: advisor.model, findings: [] };
      const stats = spent[advisor.name] ??= { reviews: 0, usage: null, lastError: null };
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        stats.lastError = "timeout: the review's time ran out before this advisor started";
        return { ...base, ok: false, error: stats.lastError };
      }
      stats.reviews += 1;
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort({ code: "timeout" }),
        Math.min(limits.reviewTimeoutSeconds * 1e3, remaining)
      );
      let tools;
      try {
        tools = await deps.createReviewTools({
          root: projectRoot,
          exclude: config.exclude,
          observations,
          advisor: { name: advisor.name },
          signal: abort.signal,
          pluginData: session.pluginData,
          credentialDir: credDir,
          secrets,
          maxFindings: MAX_FINDINGS_PER_REVIEW,
          ignoredPaths,
          tree,
          env
        });
        const result = await deps.reviewApi({
          provider,
          advisor,
          turn: turnContext,
          systemPrompt: [advisorSystemPrompt, advisor.instructions].filter(Boolean).join("\n\n"),
          tools,
          limits,
          signal: abort.signal,
          env
        });
        stats.usage = mergeUsage(stats.usage, result?.usage);
        stats.lastError = null;
        return { ...base, ok: true, findings: tools.candidates ?? [] };
      } catch (error) {
        stats.usage = mergeUsage(stats.usage, error?.usage);
        const code = typeof error?.code === "string" ? error.code : "error";
        stats.lastError = sanitizeText(`${code}: ${error instanceof Error ? error.message : "review failed"}`, secrets);
        return { ...base, ok: false, error: stats.lastError, findings: tools?.candidates ?? [] };
      } finally {
        clearTimeout(timer);
        tools?.close?.();
      }
    }),
    limits.maxConcurrentAdvisors
  );
}
var defaultDeps = {
  loadConfig,
  validateApi,
  reviewApi,
  createReviewTools,
  snapshotTree,
  turnDiff,
  gitIgnoredPaths,
  reviewBaseTree,
  now: () => Date.now()
};
async function reviewMeasured({ config, session, deps, env, projectRoot, totals, base, head, key, request, final, round, previous, deadline, spent, reviewed }) {
  const { gate, limits } = config;
  const secrets = resolveSecrets(secretNamesFromSnapshot(config), env);
  const credDir = credentialDir(env);
  const diagnosed = await diagnoseAdvisors(config, env, deps);
  const runnable = config.advisors.filter((advisor) => {
    const row = diagnosed.find((item) => item.name === advisor.name);
    const used = totals[advisor.name]?.reviews ?? 0;
    return row?.available && used < limits.maxReviewsPerAdvisorPerSession;
  });
  if (runnable.length === 0) {
    const enabled = diagnosed.filter((row) => row.enabled);
    const why = enabled.length ? enabled.map((row) => `${row.name}: ${row.available ? "session review limit reached" : row.error}`).join("; ") : "no advisor is enabled";
    return { outcome: "skipped", reason: "no available advisors", notice: why };
  }
  let ignoredPaths;
  try {
    ignoredPaths = await deps.gitIgnoredPaths(projectRoot, { env });
  } catch {
    return { outcome: "failed", reason: "could not list the paths git ignores", notice: "could not list the paths git ignores" };
  }
  let diff;
  try {
    const probe = await deps.createReviewTools({
      root: projectRoot,
      exclude: config.exclude,
      observations: [],
      pluginData: session.pluginData,
      credentialDir: credDir,
      secrets,
      ignoredPaths
    });
    diff = await deps.turnDiff(projectRoot, base, head, { env, isExcluded: probe.excluded });
  } catch {
    return { outcome: "failed", reason: "could not compute the diff", notice: "could not compute the diff" };
  }
  const changed = [...diff.files.map((file) => file.path), ...diff.omitted, ...diff.unshown];
  if (gate.skipWhenOnly?.length && changed.length) {
    const skip = (typeof import_ignore.default === "function" ? import_ignore.default : import_ignore.default.default)().add(gate.skipWhenOnly);
    if (changed.every((file) => skip.ignores(file))) {
      reviewed.push(key);
      return { outcome: "skipped", reason: "only files matching gate.skipWhenOnly changed" };
    }
  }
  if (diff.files.length === 0) {
    reviewed.push(key);
    return { outcome: "skipped", reason: "only excluded files changed" };
  }
  const files = diff.files.map((file) => ({ ...file, eventId: `diff:${file.path}`, text: sanitizeText(file.text, secrets) }));
  const turnContext = {
    request: truncateLabeled(sanitizeText(request, secrets), USER_TEXT_CAP),
    final: truncateLabeled(sanitizeText(String(final ?? ""), secrets), USER_TEXT_CAP),
    round,
    previous,
    diff: { files, omitted: diff.omitted, unshown: diff.unshown }
  };
  const observations = [{ eventId: "request" }, { eventId: "final" }, ...files.map((file) => ({ eventId: file.eventId }))];
  const results = await runAdvisors({
    runnable,
    config,
    spent,
    session,
    deps,
    env,
    secrets,
    credDir,
    ignoredPaths,
    turnContext,
    observations,
    deadline,
    tree: head,
    projectRoot
  });
  reviewed.push(key);
  const findings = collectFindings(results);
  const advisors = results.map((result) => ({
    name: result.name,
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    findings: result.findings.length,
    error: result.error
  }));
  return { outcome: "reviewed", findings, advisors, failed: results.filter((result) => !result.ok), results };
}
async function runStop(payload, options = {}) {
  const out = await stopTurn(payload, options);
  return afterStop(payload, out, options);
}
async function stopTurn(payload, { env = process.env, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + STOP_REVIEW_BUDGET_MS;
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return "";
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  const spent = {};
  const record = async (outcome, reason, extra = {}) => {
    const entry = { at: deps.now(), promptId, outcome, reason, ...extra };
    await updateState(session.dir, (fresh) => {
      fresh.turn = state.turn;
      fresh.rounds = state.rounds;
      fresh.reviewed = [.../* @__PURE__ */ new Set([...fresh.reviewed, ...state.reviewed])];
      addUsage(fresh, spent);
      if (outcome === "skipped") fresh.lastSkip = entry;
      else fresh.last = entry;
    });
    for (const name of Object.keys(spent)) delete spent[name];
  };
  const turn = state.turn;
  const stale = Boolean(turn?.stopped) && payload.stop_hook_active !== true;
  const mismatched = Boolean(promptId && turn?.promptId && turn.promptId !== promptId);
  if (!turn || stale || mismatched) {
    state.turn = null;
    const why = "the prompt hook did not snapshot this prompt";
    await record("skipped", why);
    return formatNotReviewed(why);
  }
  turn.stopped = true;
  if (turn.control) {
    await record("skipped", "control prompt");
    return "";
  }
  if (!turn.baseTree) {
    const why = `no snapshot for this prompt: ${turn.error ?? "unknown"}`;
    await record("skipped", why);
    return formatNotReviewed(why);
  }
  let config;
  try {
    config = await deps.loadConfig({ env });
  } catch (error) {
    const message = sanitizeText(error instanceof Error ? error.message : "invalid config");
    await record("failed", `config: ${message}`);
    return `${JSON.stringify({ systemMessage: `cross-model-advisor: review skipped, configuration is invalid (${message})` })}
`;
  }
  const { gate } = config;
  let head;
  try {
    head = await deps.snapshotTree(state.projectRoot, session.dir, { env });
  } catch {
    await record("failed", "could not snapshot the working tree");
    return formatNotReviewed("could not snapshot the working tree");
  }
  if (head === turn.baseTree) {
    await record("skipped", "no file changes this turn");
    return "";
  }
  const key = `${turn.baseTree}..${head}`;
  if (state.reviewed.includes(key)) {
    await record("skipped", "these changes were already reviewed");
    return "";
  }
  if (gate.mode === "advise") {
    state.reviewed.push(key);
    const stopKey = stopKeyOf(payload);
    const job = { base: turn.baseTree, head, key, request: turn.request ?? "", status: "queued", wake: Boolean(turn.wake) };
    await updateState(session.dir, (fresh) => {
      fresh.turn = state.turn;
      fresh.rounds = state.rounds;
      fresh.reviewed = [.../* @__PURE__ */ new Set([...fresh.reviewed, ...state.reviewed])];
      fresh.advise.stops = [...fresh.advise.stops.filter((stop) => stop.stopKey !== stopKey), { stopKey, at: deps.now(), job }].slice(
        -MAX_ADVISE_STOPS
      );
    });
    return "";
  }
  if (state.rounds.promptId !== promptId) state.rounds = { promptId, count: 0 };
  if (gate.mode === "block" && state.rounds.count >= gate.maxRounds) {
    await record("skipped", `round limit (${gate.maxRounds}) reached for this prompt`);
    return `${JSON.stringify({
      systemMessage: `cross-model-advisor: stopped sending Claude back after ${gate.maxRounds} review round${gate.maxRounds === 1 ? "" : "s"}. Run /cross-model-advisor:status for the last findings.`
    })}
`;
  }
  const round = state.rounds.count + 1;
  const previous = round > 1 && state.last?.promptId === promptId && Array.isArray(state.last?.findings) ? state.last.findings.map(({ severity, advisor, note }) => ({ severity, advisor, note })) : [];
  const review = await reviewMeasured({
    config,
    session,
    deps,
    env,
    projectRoot: state.projectRoot,
    totals: state.advisors,
    base: turn.baseTree,
    head,
    key,
    request: turn.request ?? "",
    final: payload.last_assistant_message,
    round,
    previous,
    deadline,
    spent,
    reviewed: state.reviewed
  });
  if (review.outcome !== "reviewed") {
    await record(review.outcome, review.reason);
    return review.notice ? formatNotReviewed(review.notice) : "";
  }
  const { findings, advisors, failed, results } = review;
  if (gate.mode === "block" && findings.some((item) => item.severity !== "nit")) {
    turn.stopped = false;
    state.rounds.count = round;
    await record("blocked", "concerns or blockers found", { round, findings, advisors });
    return `${JSON.stringify({
      decision: "block",
      reason: formatBlockReason(findings, { round, maxRounds: gate.maxRounds }),
      systemMessage: formatBlockedSummary(findings, failed, { round, maxRounds: gate.maxRounds })
    })}
`;
  }
  if (findings.length) {
    await record("reported", "findings shown to the user", { round, findings, advisors });
    return `${JSON.stringify({ systemMessage: formatUserSummary(findings, failed) })}
`;
  }
  if (failed.length === results.length) {
    await record("failed", "every advisor failed", { round, findings, advisors });
    const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
    return `${JSON.stringify({ systemMessage: truncateLabeled(`cross-model-advisor: review failed, so this turn was not reviewed (${detail})`, USER_SUMMARY_CHARS) })}
`;
  }
  await record("passed", failed.length ? "no findings from the advisors that completed" : "no findings", {
    round,
    findings,
    advisors
  });
  if (failed.length) return `${JSON.stringify({ systemMessage: formatPartialFailure(failed) })}
`;
  const names = results.map((result) => result.name).join(", ");
  return `${JSON.stringify({ systemMessage: truncateLabeled(sanitizeText(`cross-model-advisor: no findings from ${names}`), USER_SUMMARY_CHARS) })}
`;
}
function stopKeyOf(payload) {
  return createHash("sha256").update(JSON.stringify([payload?.prompt_id ?? null, payload?.stop_hook_active === true, String(payload?.last_assistant_message ?? "")])).digest("hex").slice(0, 32);
}
function pushNotice(state, user, context = null) {
  state.advise.notices = [...state.advise.notices, { id: randomUUID(), at: Date.now(), user, context }].slice(-MAX_NOTICES);
}
function joinHookOutput(first, second) {
  if (!second) return first;
  if (!first) return second;
  const a = JSON.parse(first);
  const b = JSON.parse(second);
  const systemMessage = [a.systemMessage, b.systemMessage].filter(Boolean).join("\n");
  return `${JSON.stringify({ ...a, ...systemMessage ? { systemMessage } : {} })}
`;
}
async function afterStop(payload, out, { env = process.env, deps: overrides = {} } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return out;
  const deps = { ...defaultDeps, ...overrides };
  const session = sessionFrom(env, payload);
  const seen = await loadState(session.dir);
  if (!seen.enabled) return out;
  const advise = await deps.loadConfig({ env }).then(
    (config) => config.gate.mode === "advise",
    () => false
  );
  if (!advise && !seen.advise.notices.some((notice) => notice.user)) return out;
  const stopKey = stopKeyOf(payload);
  const notices = await updateState(session.dir, (state) => {
    if (advise && !state.advise.stops.some((stop) => stop.stopKey === stopKey)) {
      state.advise.stops = [...state.advise.stops, { stopKey, at: deps.now(), job: null }].slice(-MAX_ADVISE_STOPS);
    }
    return takeNotices(state, { context: false });
  });
  return joinHookOutput(out, notices);
}
async function runAdvise(payload, { env = process.env, deps: overrides = {}, pollMs = 100, waitMs = ADVISE_WAIT_MS } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const started = deps.now();
  const deadline = started + STOP_REVIEW_BUDGET_MS;
  if (!payload || typeof payload !== "object" || payload.agent_id) return null;
  const session = sessionFrom(env, payload);
  let state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return null;
  let config;
  try {
    config = await deps.loadConfig({ env });
  } catch {
    return null;
  }
  if (config.gate.mode !== "advise") return null;
  const stopKey = stopKeyOf(payload);
  for (; ; ) {
    if (state.advise.stops.some((stop) => stop.stopKey === stopKey) || deps.now() - started > waitMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    state = await loadState(session.dir);
  }
  const claimed = await updateState(session.dir, (fresh) => {
    const stop = fresh.advise.stops.find((item) => item.stopKey === stopKey);
    if (!stop) return null;
    if (!stop.job || stop.job.status !== "queued") {
      if (!stop.job) fresh.advise.stops = fresh.advise.stops.filter((item) => item !== stop);
      return null;
    }
    stop.job.status = "running";
    return { job: { ...stop.job }, totals: structuredClone(fresh.advisors), wakes: fresh.advise.wakes, last: fresh.last };
  });
  if (!claimed) return null;
  const { job } = claimed;
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  const maxWakes = config.gate.maxRounds;
  const round = Math.min(claimed.wakes + 1, maxWakes);
  const previous = job.wake && Array.isArray(claimed.last?.findings) ? claimed.last.findings.map(({ severity, advisor, note }) => ({ severity, advisor, note })) : [];
  const spent = {};
  const reviewed = [];
  let review;
  try {
    review = await reviewMeasured({
      config,
      session,
      deps,
      env,
      projectRoot: state.projectRoot,
      totals: claimed.totals,
      base: job.base,
      head: job.head,
      key: job.key,
      request: job.request,
      final: payload.last_assistant_message,
      round,
      previous,
      deadline,
      spent,
      reviewed
    });
  } catch (error) {
    await createErrorLog(session.dir).record(error).catch(() => {
    });
    review = { outcome: "failed", reason: "the background review failed", notice: "the background review failed" };
  }
  return updateState(session.dir, (fresh) => {
    fresh.advise.stops = fresh.advise.stops.filter((item) => item.stopKey !== stopKey);
    fresh.reviewed = [.../* @__PURE__ */ new Set([...fresh.reviewed, ...reviewed])];
    addUsage(fresh, spent);
    const at = deps.now();
    if (review.outcome !== "reviewed") {
      const entry = { at, promptId, outcome: review.outcome, reason: `background: ${review.reason}` };
      if (review.outcome === "skipped") fresh.lastSkip = entry;
      else fresh.last = entry;
      if (review.notice) pushNotice(fresh, `cross-model-advisor: an earlier turn was not reviewed in the background (${review.notice})`);
      return null;
    }
    const { findings, advisors, failed, results } = review;
    const blocker = findings.some((item) => item.severity === "blocker");
    const record = (outcome, reason) => {
      fresh.last = { at, promptId, outcome, reason, round, findings, advisors };
    };
    if (blocker && fresh.enabled && fresh.advise.wakes < maxWakes) {
      fresh.advise.wakes += 1;
      const rounds = { round: fresh.advise.wakes, maxRounds: maxWakes };
      record("woke", "a blocker found in the background woke Claude");
      pushNotice(
        fresh,
        formatBackgroundCard(`a background review woke Claude with ${findings.length} finding${findings.length === 1 ? "" : "s"} on an earlier turn (wake ${rounds.round} of at most ${rounds.maxRounds})`, findings, failed)
      );
      return formatWakeReason(findings, rounds);
    }
    if (findings.length) {
      const limited = blocker ? `; not waking Claude again before your next prompt (limit ${maxWakes})` : "";
      record("reported", blocker ? "the wake limit was reached" : "findings shown with the next prompt");
      pushNotice(
        fresh,
        formatBackgroundCard(`${findings.length} finding${findings.length === 1 ? "" : "s"} from the background review of an earlier turn${limited}`, findings, failed),
        formatNoticeContext(findings)
      );
      return null;
    }
    if (failed.length === results.length) {
      const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
      record("failed", "every advisor failed");
      pushNotice(fresh, truncateLabeled(sanitizeText(`cross-model-advisor: the background review failed, so an earlier turn was not reviewed (${detail})`), USER_SUMMARY_CHARS));
      return null;
    }
    record("passed", failed.length ? "no findings from the advisors that completed" : "no findings");
    const names = results.filter((result) => result.ok).map((result) => result.name).join(", ");
    pushNotice(
      fresh,
      failed.length ? formatBackgroundCard(`no findings on an earlier turn, but ${notReviewedBy(failed)}`, [], []) : truncateLabeled(sanitizeText(`cross-model-advisor: no findings from ${names} on an earlier turn`), USER_SUMMARY_CHARS)
    );
    return null;
  });
}
async function runReview(env, { base = null } = {}, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + STOP_REVIEW_BUDGET_MS;
  if (base !== null && (!/^[A-Za-z0-9._/@{}^~-]{1,200}$/.test(base) || base.startsWith("-"))) {
    throw new GateError("base", "--base takes one git ref, such as main or origin/main");
  }
  const session = sessionFrom(env);
  const config = await deps.loadConfig({ env }).catch((error) => {
    throw new GateError("config", sanitizeText(error instanceof Error ? error.message : "invalid config"));
  });
  const top = await gitTopLevel(env.CLAUDE_PROJECT_DIR?.trim() || process.cwd(), { env });
  if (!top) throw new GateError("git", "the project is not inside a git work tree; a review needs git to see what changed");
  let projectRoot;
  try {
    projectRoot = await validateRoot(top);
  } catch (error) {
    throw new GateError("root", sanitizeText(error instanceof Error ? error.message : "invalid project root"));
  }
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);
  let from;
  let head;
  try {
    from = await deps.reviewBaseTree(projectRoot, base, { env });
    head = await deps.snapshotTree(projectRoot, session.dir, { env });
  } catch (error) {
    throw new GateError("git", sanitizeText(error instanceof Error ? error.message : "could not read the changes"));
  }
  const scope = base ? `everything since ${base} (merge base ${from.commit?.slice(0, 12)}), committed and uncommitted` : "uncommitted changes: HEAD against the working tree, untracked files included";
  const report = { ok: true, projectRoot, scope, files: [], omitted: [], unshown: [], advisors: [], findings: [] };
  if (head === from.tree) return { ...report, note: "nothing changed in this scope" };
  const secrets = resolveSecrets(secretNamesFromSnapshot(config), env);
  const credDir = credentialDir(env);
  const diagnosed = await diagnoseAdvisors(config, env, deps);
  const runnable = config.advisors.filter((advisor) => {
    const row = diagnosed.find((item) => item.name === advisor.name);
    return row?.available && (state.advisors[advisor.name]?.reviews ?? 0) < config.limits.maxReviewsPerAdvisorPerSession;
  });
  if (runnable.length === 0) {
    return { ...report, ok: false, error: "advisors", message: "no available advisors; run /cross-model-advisor:doctor" };
  }
  let ignoredPaths;
  let diff;
  try {
    ignoredPaths = await deps.gitIgnoredPaths(projectRoot, { env });
    const probe = await deps.createReviewTools({
      root: projectRoot,
      exclude: config.exclude,
      observations: [],
      pluginData: session.pluginData,
      credentialDir: credDir,
      secrets,
      ignoredPaths
    });
    diff = await deps.turnDiff(projectRoot, from.tree, head, { env, isExcluded: probe.excluded });
  } catch {
    throw new GateError("git", "could not compute the diff");
  }
  report.omitted = diff.omitted;
  report.unshown = diff.unshown;
  if (diff.files.length === 0) return { ...report, note: "only excluded files changed" };
  const files = diff.files.map((file) => ({ ...file, eventId: `diff:${file.path}`, text: sanitizeText(file.text, secrets) }));
  const turnContext = {
    request: `On-demand review requested by the user, not a single Claude turn. Scope: ${scope}. Review the change as it stands; it may span several turns and commits.`,
    final: "",
    round: 1,
    previous: [],
    diff: { files, omitted: diff.omitted, unshown: diff.unshown }
  };
  const observations = [{ eventId: "request" }, ...files.map((file) => ({ eventId: file.eventId }))];
  const spent = {};
  const results = await runAdvisors({
    runnable,
    config,
    spent,
    session,
    deps,
    env,
    secrets,
    credDir,
    ignoredPaths,
    turnContext,
    observations,
    deadline,
    tree: head,
    projectRoot
  });
  await updateState(session.dir, (fresh) => addUsage(fresh, spent));
  return {
    ...report,
    files: files.map((file) => file.path),
    advisors: results.map((result) => ({
      name: result.name,
      provider: result.provider,
      model: result.model,
      ok: result.ok,
      findings: result.findings.length,
      error: result.error
    })),
    findings: collectFindings(results)
  };
}
async function runOn(env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const session = sessionFrom(env);
  const config = await deps.loadConfig({ env }).catch((error) => {
    throw new GateError("config", sanitizeText(error instanceof Error ? error.message : "invalid config"));
  });
  const start = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const top = await gitTopLevel(start, { env });
  if (!top) throw new GateError("git", "the project is not inside a git work tree; the gate needs git to see what changed");
  let projectRoot;
  try {
    projectRoot = await validateRoot(top);
  } catch (error) {
    throw new GateError("root", sanitizeText(error instanceof Error ? error.message : "invalid project root"));
  }
  const advisors = await diagnoseAdvisors(config, env, deps);
  const enabled = advisors.some((row) => row.available);
  await updateState(session.dir, (state) => {
    state.enabled = enabled;
    state.optedOut = false;
    state.projectRoot = projectRoot;
    state.turn = { promptId: null, control: true };
    state.rounds = { promptId: null, count: 0 };
  });
  await pruneSessions(session.pluginData, session.sessionId, deps.now());
  return { ok: true, enabled, projectRoot, gate: config.gate, limits: config.limits, advisors, disclosure: DISCLOSURE };
}
async function runDoctor(env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const runtime = runtimeErrors({ env });
  let config = null;
  let configError;
  try {
    config = await deps.loadConfig({ env });
  } catch (error) {
    configError = sanitizeText(error instanceof Error ? error.message : "invalid config");
  }
  const start = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const top = await gitTopLevel(start, { env });
  const keys = config ? secretNamesFromSnapshot(config).map((name) => ({ name, present: Boolean(env[name]?.trim()) })) : [];
  const advisors = config ? await diagnoseAdvisors(config, env, deps) : [];
  const dist = path.join(env.CLAUDE_PLUGIN_ROOT || pluginRootFromHere(), "dist");
  const missing = ["control.mjs", "gate.mjs", "auth-control.mjs", "setup-control.mjs"].filter(
    (name) => !fs.existsSync(path.join(dist, name))
  );
  return {
    ok: runtime.length === 0 && Boolean(config) && Boolean(top) && missing.length === 0,
    runtime: { node: process.versions.node, platform: process.platform, errors: runtime },
    config: { ok: Boolean(config), error: configError, gate: config?.gate },
    git: { ok: Boolean(top), root: top ?? void 0, error: top ? void 0 : "not inside a git work tree" },
    keys,
    advisors,
    bundle: { ok: missing.length === 0, missing }
  };
}
async function readStdin(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new GateError("overflow", "stdin too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "stop") {
    let payload = null;
    try {
      const raw = await readStdin(process.stdin);
      payload = raw.trim() ? JSON.parse(raw) : null;
      const out = await runStop(payload, { env });
      if (out) process.stdout.write(out);
    } catch (error) {
      try {
        const session = sessionFrom(env, payload ?? {});
        await ensurePrivateDir(session.dir);
        await createErrorLog(session.dir).record(error);
      } catch {
      }
    }
    process.exitCode = 0;
    return;
  }
  if (op === "advise" && argv.length === 1) {
    let payload = null;
    let wake = null;
    try {
      const raw = await readStdin(process.stdin);
      payload = raw.trim() ? JSON.parse(raw) : null;
      wake = await runAdvise(payload, { env });
    } catch (error) {
      try {
        const session = sessionFrom(env, payload ?? {});
        await ensurePrivateDir(session.dir);
        await createErrorLog(session.dir).record(error);
      } catch {
      }
    }
    if (wake) process.stderr.write(wake, () => process.exit(2));
    else process.exit(0);
    return;
  }
  const reviewArgs = op === "review" && argv[1] === "--plugin-data" && (argv.length === 3 || argv.length === 5 && argv[3] === "--base");
  if ((op === "on" || op === "doctor") && argv.length === 3 && argv[1] === "--plugin-data" || reviewArgs) {
    let pluginData;
    try {
      pluginData = explicitPluginData(argv[2]);
    } catch {
      process.stderr.write("cross-model-advisor: identity: invalid --plugin-data; run this through the plugin's skill\n");
      process.exitCode = 1;
      return;
    }
    const scoped = { ...env, CLAUDE_PLUGIN_DATA: pluginData };
    try {
      const result = op === "on" ? await runOn(scoped) : op === "review" ? await runReview(scoped, { base: argv[4] ?? null }) : await runDoctor(scoped);
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    } catch (error) {
      const code = error instanceof GateError ? error.code : "error";
      const message = error instanceof GateError ? error.message : "command failed";
      process.stdout.write(`${JSON.stringify({ ok: false, error: code, message }, null, 2)}
`);
    }
    return;
  }
  process.stderr.write(`${USAGE}
`);
  process.exitCode = 1;
}
var realPath = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && path.basename(fileURLToPath(import.meta.url)) === "gate.mjs" && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "stop" ? 0 : 1;
  });
}
export {
  collectFindings,
  diagnoseAdvisors,
  formatBlockReason,
  formatBlockedSummary,
  formatNotReviewed,
  formatPartialFailure,
  formatUserSummary,
  formatWakeReason,
  main,
  runAdvise,
  runDoctor,
  runOn,
  runReview,
  runStop,
  stopKeyOf
};
