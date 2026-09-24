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

// ../../plugins/cross-model-advisor/src/tools.mjs
var import_ignore = __toESM(require_ignore(), 1);
import { Buffer as Buffer2, isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { validateRoot } from "./config.mjs";
var ignore = typeof import_ignore.default === "function" ? import_ignore.default : import_ignore.default.default;
var MAX_READ_FILE_BYTES = 1024 * 1024;
var MAX_READ_LINES_DEFAULT = 200;
var MAX_READ_LINES = 500;
var MAX_READ_RETURN_BYTES = 64 * 1024;
var MAX_LIST_DEPTH = 3;
var MAX_LIST_ENTRIES = 200;
var MAX_SEARCH_MATCHES = 50;
var MAX_SEARCH_RETURN_BYTES = 64 * 1024;
var MAX_SEARCH_SCAN_BYTES = 10 * 1024 * 1024;
var MAX_SEARCH_FILES = 1e4;
var MAX_NOTE_CHARS = 2e3;
var MAX_DETAIL_CHARS = 500;
var MAX_EVIDENCE = 5;
var MAX_WATCHDOG_BYTES = 8 * 1024;
var MAX_IGNORE_BYTES = 256 * 1024;
var OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0);
var HARD_DIR_NAMES = /* @__PURE__ */ new Set([".git", ".claude", ".codex", ".gemini", "node_modules"]);
var SEVERITIES = /* @__PURE__ */ new Set(["nit", "concern", "blocker"]);
var PRAISE_RE = /^(?:thanks|thank you|thx|ty|tysm|looks good(?: to me)?|lgtm|sgtm|ack(?:nowledged)?|ok(?:ay)?|got it|sounds good|great(?: work)?|nice(?: work)?|well done|cheers)(?:[.!])*$/i;
var CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi;
var CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
var PROJECT_IGNORE = ".cross-model-advisorignore";
var WATCHDOG_NAME = "WATCHDOG.md";
var TRUNCATED_MARKER = "[truncated]";
function normalizeFinding(note) {
  return String(note ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function sanitizeText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(CONTROL_CHARS, "");
  const ordered = secrets.filter((secret) => typeof secret === "string" && secret.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join("[redacted]");
  out = out.replace(CREDENTIAL_ASSIGNMENT, (match, value) => match.replace(value, "[redacted]"));
  return out;
}
function denied(message = "access denied") {
  return `Error: ${message}`;
}
function posixRel(rel) {
  if (!rel) return "";
  return rel.split(path.sep).join("/");
}
function isOutside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}
function sameIdent(a, b) {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}
function hardExcluded(relPosix) {
  if (!relPosix) return false;
  for (const part of relPosix.split("/")) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (HARD_DIR_NAMES.has(lower)) return true;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
  }
  return false;
}
function objectArgs(args, allowed) {
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) return null;
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return null;
  }
  return args;
}
function contentFree(note) {
  const normalized = normalizeFinding(note);
  if (!normalized) return true;
  if (PRAISE_RE.test(normalized)) return true;
  return !/[a-z0-9]/i.test(normalized);
}
function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}
function utf8Len(text) {
  return Buffer2.byteLength(String(text ?? ""), "utf8");
}
function capUtf8(text, maxBytes) {
  const buf = Buffer2.from(String(text ?? ""), "utf8");
  if (buf.length <= maxBytes) return { text: buf.toString("utf8"), truncated: false };
  let end = Math.max(0, Math.min(maxBytes, buf.length));
  while (end > 0 && (buf[end] & 192) === 128) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}
function boundItems(items, maxBytes, secrets) {
  const marker = items.length ? `
${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
  const markerBytes = utf8Len(marker);
  const kept = [];
  let used = 0;
  for (let i = 0; i < items.length; i += 1) {
    const text2 = sanitizeText(items[i], secrets);
    const piece = (kept.length ? "\n" : "") + text2;
    const n = utf8Len(piece);
    const more = i < items.length - 1;
    if (used + n > maxBytes) break;
    if (more && used + n + markerBytes > maxBytes) break;
    kept.push(text2);
    used += n;
  }
  const truncated = kept.length < items.length;
  let text = kept.join("\n");
  if (truncated) {
    const suffix = text ? `
${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
    if (utf8Len(text) + utf8Len(suffix) <= maxBytes) text += suffix;
    else {
      const room = Math.max(0, maxBytes - utf8Len(suffix));
      const capped = capUtf8(text, room);
      text = `${capped.text}${suffix}`;
      if (capped.truncated && kept.length) kept.pop();
    }
  }
  return { text, kept, truncated };
}
async function readPolicyFile(abs, { maxBytes, allowPartial = false, onSymlink = "denyAll" } = {}) {
  let lstat;
  try {
    lstat = await fs.lstat(abs);
  } catch (error) {
    if (error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "denyAll" };
  }
  if (lstat.isSymbolicLink()) return { kind: onSymlink === "skip" ? "missing" : "denyAll" };
  if (!lstat.isFile()) return { kind: "denyAll" };
  if (!allowPartial && lstat.size > maxBytes) return { kind: "denyAll" };
  let handle;
  try {
    handle = await fs.open(abs, OPEN_FLAGS);
    const stat = await handle.stat();
    if (stat.dev !== lstat.dev || stat.ino !== lstat.ino || !stat.isFile()) {
      await handle.close().catch(() => {
      });
      return { kind: "denyAll" };
    }
    const size = Number(stat.size);
    const take = Math.min(size, maxBytes);
    const buf = Buffer2.alloc(take);
    let offset = 0;
    while (offset < take) {
      const got = await handle.read(buf, offset, take - offset, offset);
      if (got.bytesRead === 0) break;
      offset += got.bytesRead;
    }
    await handle.close().catch(() => {
    });
    const bytes = offset === take ? buf : buf.subarray(0, offset);
    if (bytes.includes(0) || !isUtf8(bytes)) return { kind: "denyAll" };
    return { kind: "text", bytes, truncated: size > bytes.length };
  } catch {
    if (handle) await handle.close().catch(() => {
    });
    return { kind: "denyAll" };
  }
}
function ignoreFrom(text) {
  const ig = ignore();
  const kept = [];
  for (const line of splitLines(String(text ?? ""))) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("!")) continue;
    kept.push(line);
  }
  if (kept.length) ig.add(kept);
  return ig;
}
function gitignoreFrom(text) {
  const ig = ignore();
  ig.add(String(text ?? ""));
  return ig;
}
function ignoredBy(ig, relPosix, isDir) {
  if (!ig || !relPosix) return false;
  if (ig.ignores(relPosix)) return true;
  if (isDir && ig.ignores(`${relPosix}/`)) return true;
  return false;
}
function testIgnore(ig, local, isDir) {
  if (!ig || !local) return { ignored: false, unignored: false };
  const t = ig.test(isDir ? `${local.replace(/\/$/, "")}/` : local);
  return { ignored: Boolean(t.ignored), unignored: Boolean(t.unignored) };
}
var toolSchemas = Object.freeze([
  Object.freeze({
    name: "read",
    description: "Read numbered UTF-8 text from a project-relative path. Default 200 lines; at most 500 lines and 64 KiB returned. Refuses files over 1 MiB, binary content, excluded paths, and symlinks.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: Object.freeze({
        path: { type: "string", description: "Project-relative or in-root path." },
        offset: { type: "integer", minimum: 1, description: "1-based start line." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Number of lines to return." }
      })
    })
  }),
  Object.freeze({
    name: "list",
    description: "List project-relative entries. Depth 1 by default, maximum depth 3 and 200 entries, deterministic order. Does not follow symlinks or show excluded names.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        path: { type: "string", description: "Project-relative directory. Defaults to the project root." },
        depth: { type: "integer", minimum: 1, maximum: 3 }
      })
    })
  }),
  Object.freeze({
    name: "search",
    description: "Literal text search (not regex) under the project. Maximum 50 matches and 64 KiB returned, 10 MiB scanned. Reports incomplete coverage when a bound is reached.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: Object.freeze({
        query: { type: "string" },
        path: { type: "string" },
        caseSensitive: { type: "boolean" }
      })
    })
  }),
  Object.freeze({
    name: "advise",
    description: "Record one evidence-backed finding; call once per distinct problem. severity is nit, concern, or blocker. note at most 2000 characters. evidence is 1-5 references: a file line you read with the read tool, or an observation eventId from the review context (request, final, or diff:<path>). The host reports findings only after the review completes successfully.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["severity", "note", "evidence"],
      properties: Object.freeze({
        severity: { type: "string", enum: ["nit", "concern", "blocker"] },
        note: { type: "string", maxLength: 2e3 },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "detail"],
            properties: {
              kind: { type: "string", enum: ["file", "observation"] },
              path: { type: "string" },
              line: { type: "integer", minimum: 1 },
              detail: { type: "string" },
              eventId: { type: "string" }
            }
          }
        }
      })
    })
  })
]);
async function createReviewTools({
  root,
  rootIdent,
  exclude = [],
  observations = [],
  advisor,
  signal,
  pluginData,
  credentialDir,
  secrets = [],
  maxFindings = 1
} = {}) {
  const frozenRoot = await validateRoot(root, { follow: false });
  const liveRoot = await fs.lstat(frozenRoot);
  if (liveRoot.isSymbolicLink() || !liveRoot.isDirectory()) {
    const error = new Error("project root changed");
    error.name = "ConfigError";
    throw error;
  }
  const expectedIdent = rootIdent && rootIdent.dev != null && rootIdent.ino != null ? { dev: rootIdent.dev, ino: rootIdent.ino } : { dev: liveRoot.dev, ino: liveRoot.ino };
  if (!sameIdent(liveRoot, expectedIdent)) {
    const error = new Error("project root changed");
    error.name = "ConfigError";
    throw error;
  }
  const secretList = Array.isArray(secrets) ? secrets.filter((item) => typeof item === "string") : [];
  const observationIds = /* @__PURE__ */ new Set();
  for (const observation of Array.isArray(observations) ? observations : []) {
    const id = observation?.eventId ?? observation?.id;
    if (typeof id === "string" && id) observationIds.add(id);
  }
  const fingerprints = new Set(
    Array.isArray(advisor?.fingerprints) ? advisor.fingerprints.map((item) => String(item)) : []
  );
  const privateRels = [];
  for (const privateDir of [pluginData, credentialDir]) {
    if (typeof privateDir !== "string" || !privateDir) continue;
    let ancestor = path.resolve(privateDir);
    const missing = [];
    let canonical;
    for (; ; ) {
      try {
        canonical = path.join(await fs.realpath(ancestor), ...missing);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || path.dirname(ancestor) === ancestor) {
          throw new Error("unable to protect private storage path");
        }
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    if (!isOutside(canonical, frozenRoot)) privateRels.push("");
    else if (!isOutside(frozenRoot, canonical)) {
      privateRels.push(posixRel(path.relative(frozenRoot, canonical)));
    }
  }
  const userIgnore = ignoreFrom(
    (Array.isArray(exclude) ? exclude : []).filter((pattern) => typeof pattern === "string").join("\n")
  );
  const projectPolicy = await readPolicyFile(path.join(frozenRoot, PROJECT_IGNORE), {
    maxBytes: MAX_IGNORE_BYTES
  });
  if (projectPolicy.kind === "denyAll") userIgnore.add("*");
  else if (projectPolicy.kind === "text") {
    const extra = [];
    for (const line of splitLines(projectPolicy.bytes.toString("utf8"))) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      extra.push(line);
    }
    if (extra.length) userIgnore.add(extra);
  }
  const gitignoreCache = /* @__PURE__ */ new Map();
  const reads = /* @__PURE__ */ new Map();
  const findingLimit = Number.isInteger(maxFindings) && maxFindings > 0 ? maxFindings : 1;
  const staged = [];
  function checkAbort() {
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error("aborted");
    }
  }
  async function rootStillValid() {
    try {
      const st = await fs.lstat(frozenRoot);
      return !st.isSymbolicLink() && st.isDirectory() && sameIdent(st, expectedIdent);
    } catch {
      return false;
    }
  }
  function privatePathExcluded(relPosix) {
    return privateRels.some((rel) => rel === "" || relPosix === rel || relPosix.startsWith(`${rel}/`));
  }
  async function gitignoreFor(dirRel) {
    if (gitignoreCache.has(dirRel)) return gitignoreCache.get(dirRel);
    const abs = dirRel ? path.join(frozenRoot, ...dirRel.split("/")) : frozenRoot;
    const policy = await readPolicyFile(path.join(abs, ".gitignore"), { maxBytes: MAX_IGNORE_BYTES });
    let stored = null;
    if (policy.kind === "denyAll") stored = { denyAll: true };
    else if (policy.kind === "text") stored = { ig: gitignoreFrom(policy.bytes.toString("utf8")) };
    gitignoreCache.set(dirRel, stored);
    return stored;
  }
  async function gitPathIgnored(relPosix, isDir) {
    const parts = relPosix.split("/").filter(Boolean);
    const dirs = [""];
    for (let i = 0; i < parts.length - 1; i += 1) dirs.push(parts.slice(0, i + 1).join("/"));
    let ignored = false;
    for (const dirRel of dirs) {
      const entry = await gitignoreFor(dirRel);
      if (entry?.denyAll) return true;
      if (!entry?.ig) continue;
      const local = dirRel ? relPosix.slice(dirRel.length + 1) : relPosix;
      const t = testIgnore(entry.ig, local, isDir);
      if (t.ignored) ignored = true;
      if (t.unignored) ignored = false;
    }
    return ignored;
  }
  async function isExcluded(relPosix, isDir) {
    if (privatePathExcluded(relPosix)) return true;
    if (!relPosix) return false;
    if (hardExcluded(relPosix)) return true;
    if (ignoredBy(userIgnore, relPosix, isDir)) return true;
    const parts = relPosix.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const ancestor = parts.slice(0, i + 1).join("/");
      if (hardExcluded(ancestor) || privatePathExcluded(ancestor)) return true;
      if (ignoredBy(userIgnore, ancestor, true)) return true;
      if (await gitPathIgnored(ancestor, true)) return true;
    }
    return gitPathIgnored(relPosix, isDir);
  }
  async function resolveInside(userPath, { allowRoot = false } = {}) {
    if (!await rootStillValid()) return { error: denied() };
    if (typeof userPath !== "string" || userPath.includes("\0")) return { error: denied() };
    const trimmed = userPath.trim();
    if (!trimmed) {
      if (!allowRoot) return { error: denied() };
      return { relPosix: "", abs: frozenRoot };
    }
    const joined = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.normalize(path.join(frozenRoot, trimmed));
    if (isOutside(frozenRoot, joined)) return { error: denied() };
    const relPosix = posixRel(path.relative(frozenRoot, joined));
    let abs = frozenRoot;
    if (relPosix) {
      for (const part of relPosix.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") return { error: denied() };
        abs = path.join(abs, part);
        let lstat;
        try {
          lstat = await fs.lstat(abs);
        } catch {
          return { error: denied() };
        }
        if (lstat.isSymbolicLink()) return { error: denied() };
      }
    }
    if (isOutside(frozenRoot, abs)) return { error: denied() };
    return { relPosix, abs };
  }
  async function verifyOpened(handle, abs) {
    if (!await rootStillValid()) return false;
    const fdStat = await handle.stat();
    let resolved;
    try {
      resolved = await fs.realpath(abs);
    } catch {
      return false;
    }
    if (isOutside(frozenRoot, resolved)) return false;
    let resolvedStat;
    try {
      resolvedStat = await fs.stat(resolved);
    } catch {
      return false;
    }
    if (!sameIdent(resolvedStat, fdStat)) return false;
    let cur = frozenRoot;
    const rel = posixRel(path.relative(frozenRoot, abs));
    if (rel) {
      for (const part of rel.split("/")) {
        cur = path.join(cur, part);
        let st;
        try {
          st = await fs.lstat(cur);
        } catch {
          return false;
        }
        if (st.isSymbolicLink()) return false;
      }
    }
    let finalLst;
    try {
      finalLst = await fs.lstat(abs);
    } catch {
      return false;
    }
    if (finalLst.isSymbolicLink() || !sameIdent(finalLst, fdStat)) return false;
    return rootStillValid();
  }
  async function openFile(abs) {
    let lstat;
    try {
      lstat = await fs.lstat(abs);
    } catch {
      return { error: denied(), readBytes: 0 };
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) return { error: denied(), readBytes: 0 };
    let handle;
    try {
      handle = await fs.open(abs, OPEN_FLAGS);
      const stat = await handle.stat();
      if (!sameIdent(stat, lstat) || !stat.isFile()) {
        await handle.close().catch(() => {
        });
        return { error: denied(), readBytes: 0 };
      }
      if (!await verifyOpened(handle, abs)) {
        await handle.close().catch(() => {
        });
        return { error: denied(), readBytes: 0 };
      }
      if (stat.size > MAX_READ_FILE_BYTES) {
        await handle.close().catch(() => {
        });
        return { error: denied("file too large"), readBytes: 0 };
      }
      const buf = Buffer2.alloc(Number(stat.size));
      let offset = 0;
      while (offset < buf.length) {
        const got = await handle.read(buf, offset, buf.length - offset, offset);
        if (got.bytesRead === 0) break;
        offset += got.bytesRead;
      }
      await handle.close().catch(() => {
      });
      const bytes = offset === buf.length ? buf : buf.subarray(0, offset);
      if (bytes.includes(0) || !isUtf8(bytes)) {
        return { error: denied("binary file"), readBytes: bytes.length };
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { bytes, hash, stat, readBytes: bytes.length };
    } catch {
      if (handle) await handle.close().catch(() => {
      });
      return { error: denied(), readBytes: 0 };
    }
  }
  async function toolRead(args) {
    const parsed = objectArgs(args, ["path", "offset", "limit"]);
    if (!parsed || typeof parsed.path !== "string") return denied("invalid arguments");
    if ("offset" in parsed && (!Number.isInteger(parsed.offset) || parsed.offset < 1)) {
      return denied("invalid arguments");
    }
    if ("limit" in parsed && (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > MAX_READ_LINES)) {
      return denied("invalid arguments");
    }
    const located = await resolveInside(parsed.path);
    if (located.error) return located.error;
    if (await isExcluded(located.relPosix, false)) return denied();
    const opened = await openFile(located.abs);
    if (opened.error) return opened.error;
    const lines = splitLines(opened.bytes.toString("utf8"));
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const offset = parsed.offset ?? 1;
    const limit = parsed.limit ?? MAX_READ_LINES_DEFAULT;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const end = offset + slice.length - 1;
    const width = String(Math.max(end, 1)).length;
    const rows = slice.map((line, index) => `${String(offset + index).padStart(width)}|${line}`);
    const bounded = boundItems(rows, MAX_READ_RETURN_BYTES, secretList);
    const shown = /* @__PURE__ */ new Set();
    for (let i = 0; i < bounded.kept.length; i += 1) shown.add(offset + i);
    const prev = reads.get(located.relPosix);
    if (prev && prev.hash === opened.hash) {
      for (const line of shown) prev.lines.add(line);
    } else {
      reads.set(located.relPosix, { hash: opened.hash, lines: shown });
    }
    return bounded.text;
  }
  async function readDirents(abs) {
    let lstat;
    try {
      lstat = await fs.lstat(abs);
    } catch {
      return { error: denied() };
    }
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return { error: denied() };
    let handle;
    try {
      handle = await fs.open(abs, OPEN_FLAGS | (constants.O_DIRECTORY ?? 0));
      const stat = await handle.stat();
      if (!sameIdent(stat, lstat) || !stat.isDirectory()) {
        await handle.close().catch(() => {
        });
        return { error: denied() };
      }
      if (!await verifyOpened(handle, abs)) {
        await handle.close().catch(() => {
        });
        return { error: denied() };
      }
      let names;
      try {
        names = await fs.readdir(abs);
      } catch {
        await handle.close().catch(() => {
        });
        return { error: denied() };
      }
      const later = await fs.lstat(abs);
      const fdLater = await handle.stat();
      await handle.close().catch(() => {
      });
      if (later.isSymbolicLink() || !later.isDirectory() || !sameIdent(later, stat) || !sameIdent(fdLater, stat)) {
        return { error: denied() };
      }
      names.sort((a, b) => a.localeCompare(b));
      const entries = [];
      for (const name of names) {
        if (name.includes("\0")) continue;
        const child = path.join(abs, name);
        let st;
        try {
          st = await fs.lstat(child);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (!st.isDirectory() && !st.isFile()) continue;
        entries.push({ name, directory: st.isDirectory() });
      }
      return { entries };
    } catch {
      if (handle) await handle.close().catch(() => {
      });
      return { error: denied() };
    }
  }
  async function toolList(args) {
    const parsed = objectArgs(args, ["path", "depth"]);
    if (!parsed) return denied("invalid arguments");
    if ("depth" in parsed && (!Number.isInteger(parsed.depth) || parsed.depth < 1 || parsed.depth > MAX_LIST_DEPTH)) {
      return denied("invalid arguments");
    }
    const located = await resolveInside(parsed.path ?? "", { allowRoot: true });
    if (located.error) return located.error;
    if (located.relPosix && await isExcluded(located.relPosix, true)) return denied();
    let startStat;
    try {
      startStat = await fs.lstat(located.abs);
    } catch {
      return denied();
    }
    if (startStat.isSymbolicLink() || !startStat.isDirectory()) return denied();
    const depth = parsed.depth ?? 1;
    const lines = [];
    let truncated = false;
    const walk = async (relPosix, remaining) => {
      checkAbort();
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const resolved = await resolveInside(relPosix, { allowRoot: true });
      if (resolved.error) return;
      const listed = await readDirents(resolved.abs);
      if (listed.error) return;
      for (const entry of listed.entries) {
        if (lines.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
        if (await isExcluded(childRel, entry.directory)) continue;
        lines.push(entry.directory ? `${childRel}/` : childRel);
        if (entry.directory && remaining > 1) await walk(childRel, remaining - 1);
      }
    };
    await walk(located.relPosix, depth);
    if (truncated) lines.push(TRUNCATED_MARKER);
    return sanitizeText(lines.join("\n"), secretList);
  }
  async function toolSearch(args) {
    const parsed = objectArgs(args, ["query", "path", "caseSensitive"]);
    if (!parsed || typeof parsed.query !== "string" || parsed.query.length === 0) {
      return denied("invalid arguments");
    }
    if ("caseSensitive" in parsed && typeof parsed.caseSensitive !== "boolean") {
      return denied("invalid arguments");
    }
    const located = await resolveInside(parsed.path ?? "", { allowRoot: true });
    if (located.error) return located.error;
    if (located.relPosix && await isExcluded(located.relPosix, true)) return denied();
    const caseSensitive = parsed.caseSensitive === true;
    const needle = caseSensitive ? parsed.query : parsed.query.toLowerCase();
    const matches = [];
    let scanned = 0;
    let files = 0;
    let incomplete = false;
    const consider = async (relPosix, isDir) => {
      checkAbort();
      if (incomplete || matches.length >= MAX_SEARCH_MATCHES) {
        incomplete = true;
        return;
      }
      if (relPosix && await isExcluded(relPosix, isDir)) return;
      const resolved = await resolveInside(relPosix, { allowRoot: true });
      if (resolved.error) return;
      if (isDir) {
        const listed = await readDirents(resolved.abs);
        if (listed.error) return;
        for (const entry of listed.entries) {
          if (incomplete || matches.length >= MAX_SEARCH_MATCHES) {
            incomplete = true;
            return;
          }
          const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
          await consider(childRel, entry.directory);
        }
        return;
      }
      files += 1;
      if (files > MAX_SEARCH_FILES) {
        incomplete = true;
        return;
      }
      let lst;
      try {
        lst = await fs.lstat(resolved.abs);
      } catch {
        return;
      }
      if (lst.isSymbolicLink() || !lst.isFile()) return;
      if (scanned >= MAX_SEARCH_SCAN_BYTES) {
        incomplete = true;
        return;
      }
      if (lst.size > MAX_READ_FILE_BYTES) {
        incomplete = true;
        return;
      }
      if (scanned + Number(lst.size) > MAX_SEARCH_SCAN_BYTES) {
        incomplete = true;
        return;
      }
      const opened = await openFile(resolved.abs);
      scanned += opened.readBytes ?? 0;
      if (scanned > MAX_SEARCH_SCAN_BYTES) incomplete = true;
      if (opened.error) return;
      const text = opened.bytes.toString("utf8");
      const lines = splitLines(text);
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i += 1) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (!hay.includes(needle)) continue;
        matches.push(`${relPosix}:${i + 1}:${lines[i]}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          incomplete = true;
          return;
        }
      }
    };
    let startStat;
    try {
      startStat = await fs.lstat(located.abs);
    } catch {
      return denied();
    }
    if (startStat.isSymbolicLink()) return denied();
    await consider(located.relPosix, startStat.isDirectory());
    const bounded = boundItems(matches, MAX_SEARCH_RETURN_BYTES, secretList);
    if (incomplete || bounded.truncated) {
      if (!bounded.text.includes(TRUNCATED_MARKER)) {
        const suffix = bounded.text ? `
${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
        const combined = `${bounded.text}${suffix}`;
        return utf8Len(combined) <= MAX_SEARCH_RETURN_BYTES ? combined : bounded.text;
      }
    }
    return bounded.text;
  }
  function validateEvidenceItem(item) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (item.kind === "file") {
      if (keys.some((key) => !["kind", "path", "line", "detail"].includes(key))) return null;
      if (typeof item.path !== "string" || item.path.includes("\0")) return null;
      if (!Number.isInteger(item.line) || item.line < 1) return null;
      if (typeof item.detail !== "string" || item.detail.length === 0 || item.detail.length > MAX_DETAIL_CHARS) {
        return null;
      }
      const joined = path.isAbsolute(item.path) ? path.normalize(item.path) : path.normalize(path.join(frozenRoot, item.path));
      if (isOutside(frozenRoot, joined)) return null;
      const relPosix = posixRel(path.relative(frozenRoot, joined));
      const recorded = reads.get(relPosix);
      if (!recorded || !recorded.lines.has(item.line)) return null;
      return {
        kind: "file",
        path: relPosix,
        line: item.line,
        detail: item.detail,
        hash: recorded.hash
      };
    }
    if (item.kind === "observation") {
      if (keys.some((key) => !["kind", "eventId", "detail"].includes(key))) return null;
      if (typeof item.eventId !== "string" || !item.eventId || !observationIds.has(item.eventId)) return null;
      if (typeof item.detail !== "string" || item.detail.length === 0 || item.detail.length > MAX_DETAIL_CHARS) {
        return null;
      }
      return { kind: "observation", eventId: item.eventId, detail: item.detail };
    }
    return null;
  }
  async function toolAdvise(args) {
    const parsed = objectArgs(args, ["severity", "note", "evidence"]);
    if (!parsed) return denied("invalid arguments");
    if (staged.length >= findingLimit) return denied("finding limit reached");
    if (!SEVERITIES.has(parsed.severity)) return denied("invalid arguments");
    if (typeof parsed.note !== "string" || parsed.note.length === 0 || parsed.note.length > MAX_NOTE_CHARS) {
      return denied("invalid arguments");
    }
    if (contentFree(parsed.note)) return denied("invalid arguments");
    const normalized = normalizeFinding(parsed.note);
    if (fingerprints.has(normalized)) return denied("duplicate finding");
    if (!Array.isArray(parsed.evidence) || parsed.evidence.length < 1 || parsed.evidence.length > MAX_EVIDENCE) {
      return denied("invalid arguments");
    }
    const evidence = [];
    for (const item of parsed.evidence) {
      const valid = validateEvidenceItem(item);
      if (!valid) return denied("invalid evidence");
      evidence.push(valid);
    }
    staged.push({
      severity: parsed.severity,
      note: sanitizeText(parsed.note, secretList),
      evidence
    });
    fingerprints.add(normalized);
    return "staged";
  }
  async function isFresh(target) {
    if (!await rootStillValid()) return false;
    const evidence = Array.isArray(target) ? target : Array.isArray(target?.evidence) ? target.evidence : [];
    for (const item of evidence) {
      if (item?.kind !== "file") continue;
      if (typeof item.path !== "string" || typeof item.hash !== "string") return false;
      if (await isExcluded(item.path, false)) return false;
      const located = await resolveInside(item.path);
      if (located.error) return false;
      const opened = await openFile(located.abs);
      if (opened.error || opened.hash !== item.hash) return false;
    }
    return true;
  }
  async function call(name, args) {
    checkAbort();
    if (!await rootStillValid()) return denied();
    if (name === "read") return toolRead(args);
    if (name === "list") return toolList(args);
    if (name === "search") return toolSearch(args);
    if (name === "advise") return toolAdvise(args);
    throw new Error(`unknown tool: ${name}`);
  }
  let guidance = "";
  if (!await isExcluded(WATCHDOG_NAME, false)) {
    const watchdog = await readPolicyFile(path.join(frozenRoot, WATCHDOG_NAME), {
      maxBytes: MAX_WATCHDOG_BYTES,
      allowPartial: true,
      onSymlink: "skip"
    });
    if (watchdog.kind === "text") {
      guidance = sanitizeText(watchdog.bytes.toString("utf8"), secretList);
      if (watchdog.truncated) {
        const bounded = boundItems(splitLines(guidance), MAX_WATCHDOG_BYTES, secretList);
        guidance = bounded.text;
      }
    }
  }
  return {
    call,
    isFresh,
    /** The same exclusion rules the read/list/search tools apply. */
    excluded: (relPosix) => isExcluded(relPosix, false),
    get candidate() {
      return staged.length ? structuredClone(staged[0]) : null;
    },
    get candidates() {
      return structuredClone(staged);
    },
    get done() {
      return staged.length >= findingLimit;
    },
    guidance
  };
}
export {
  createReviewTools,
  normalizeFinding,
  toolSchemas
};
