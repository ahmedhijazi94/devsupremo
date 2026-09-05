#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// node_modules/commander/lib/error.js
var require_error = __commonJS({
  "node_modules/commander/lib/error.js"(exports2) {
    var CommanderError2 = class extends Error {
      /**
       * Constructs the CommanderError class
       * @param {number} exitCode suggested exit code which could be used with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       */
      constructor(exitCode, code, message) {
        super(message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
        this.code = code;
        this.exitCode = exitCode;
        this.nestedError = void 0;
      }
    };
    var InvalidArgumentError2 = class extends CommanderError2 {
      /**
       * Constructs the InvalidArgumentError class
       * @param {string} [message] explanation of why argument is invalid
       */
      constructor(message) {
        super(1, "commander.invalidArgument", message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
      }
    };
    exports2.CommanderError = CommanderError2;
    exports2.InvalidArgumentError = InvalidArgumentError2;
  }
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS({
  "node_modules/commander/lib/argument.js"(exports2) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Argument2 = class {
      /**
       * Initialize a new command argument with the given name and description.
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @param {string} name
       * @param {string} [description]
       */
      constructor(name, description) {
        this.description = description || "";
        this.variadic = false;
        this.parseArg = void 0;
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.argChoices = void 0;
        switch (name[0]) {
          case "<":
            this.required = true;
            this._name = name.slice(1, -1);
            break;
          case "[":
            this.required = false;
            this._name = name.slice(1, -1);
            break;
          default:
            this.required = true;
            this._name = name;
            break;
        }
        if (this._name.length > 3 && this._name.slice(-3) === "...") {
          this.variadic = true;
          this._name = this._name.slice(0, -3);
        }
      }
      /**
       * Return argument name.
       *
       * @return {string}
       */
      name() {
        return this._name;
      }
      /**
       * @package
       */
      _concatValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        return previous.concat(value);
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Argument}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Set the custom handler for processing CLI command arguments into argument values.
       *
       * @param {Function} [fn]
       * @return {Argument}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Only allow argument value to be one of choices.
       *
       * @param {string[]} values
       * @return {Argument}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._concatValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Make argument required.
       *
       * @returns {Argument}
       */
      argRequired() {
        this.required = true;
        return this;
      }
      /**
       * Make argument optional.
       *
       * @returns {Argument}
       */
      argOptional() {
        this.required = false;
        return this;
      }
    };
    function humanReadableArgName(arg) {
      const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
      return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
    }
    exports2.Argument = Argument2;
    exports2.humanReadableArgName = humanReadableArgName;
  }
});

// node_modules/commander/lib/help.js
var require_help = __commonJS({
  "node_modules/commander/lib/help.js"(exports2) {
    var { humanReadableArgName } = require_argument();
    var Help2 = class {
      constructor() {
        this.helpWidth = void 0;
        this.sortSubcommands = false;
        this.sortOptions = false;
        this.showGlobalOptions = false;
      }
      /**
       * Get an array of the visible subcommands. Includes a placeholder for the implicit help command, if there is one.
       *
       * @param {Command} cmd
       * @returns {Command[]}
       */
      visibleCommands(cmd) {
        const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
        const helpCommand = cmd._getHelpCommand();
        if (helpCommand && !helpCommand._hidden) {
          visibleCommands.push(helpCommand);
        }
        if (this.sortSubcommands) {
          visibleCommands.sort((a, b) => {
            return a.name().localeCompare(b.name());
          });
        }
        return visibleCommands;
      }
      /**
       * Compare options for sort.
       *
       * @param {Option} a
       * @param {Option} b
       * @returns {number}
       */
      compareOptions(a, b) {
        const getSortKey = (option) => {
          return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
        };
        return getSortKey(a).localeCompare(getSortKey(b));
      }
      /**
       * Get an array of the visible options. Includes a placeholder for the implicit help option, if there is one.
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleOptions(cmd) {
        const visibleOptions = cmd.options.filter((option) => !option.hidden);
        const helpOption = cmd._getHelpOption();
        if (helpOption && !helpOption.hidden) {
          const removeShort = helpOption.short && cmd._findOption(helpOption.short);
          const removeLong = helpOption.long && cmd._findOption(helpOption.long);
          if (!removeShort && !removeLong) {
            visibleOptions.push(helpOption);
          } else if (helpOption.long && !removeLong) {
            visibleOptions.push(
              cmd.createOption(helpOption.long, helpOption.description)
            );
          } else if (helpOption.short && !removeShort) {
            visibleOptions.push(
              cmd.createOption(helpOption.short, helpOption.description)
            );
          }
        }
        if (this.sortOptions) {
          visibleOptions.sort(this.compareOptions);
        }
        return visibleOptions;
      }
      /**
       * Get an array of the visible global options. (Not including help.)
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleGlobalOptions(cmd) {
        if (!this.showGlobalOptions)
          return [];
        const globalOptions = [];
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          const visibleOptions = ancestorCmd.options.filter(
            (option) => !option.hidden
          );
          globalOptions.push(...visibleOptions);
        }
        if (this.sortOptions) {
          globalOptions.sort(this.compareOptions);
        }
        return globalOptions;
      }
      /**
       * Get an array of the arguments if any have a description.
       *
       * @param {Command} cmd
       * @returns {Argument[]}
       */
      visibleArguments(cmd) {
        if (cmd._argsDescription) {
          cmd.registeredArguments.forEach((argument) => {
            argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
          });
        }
        if (cmd.registeredArguments.find((argument) => argument.description)) {
          return cmd.registeredArguments;
        }
        return [];
      }
      /**
       * Get the command term to show in the list of subcommands.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandTerm(cmd) {
        const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
        return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + // simplistic check for non-help option
        (args ? " " + args : "");
      }
      /**
       * Get the option term to show in the list of options.
       *
       * @param {Option} option
       * @returns {string}
       */
      optionTerm(option) {
        return option.flags;
      }
      /**
       * Get the argument term to show in the list of arguments.
       *
       * @param {Argument} argument
       * @returns {string}
       */
      argumentTerm(argument) {
        return argument.name();
      }
      /**
       * Get the longest command term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestSubcommandTermLength(cmd, helper) {
        return helper.visibleCommands(cmd).reduce((max, command) => {
          return Math.max(max, helper.subcommandTerm(command).length);
        }, 0);
      }
      /**
       * Get the longest option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestOptionTermLength(cmd, helper) {
        return helper.visibleOptions(cmd).reduce((max, option) => {
          return Math.max(max, helper.optionTerm(option).length);
        }, 0);
      }
      /**
       * Get the longest global option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestGlobalOptionTermLength(cmd, helper) {
        return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
          return Math.max(max, helper.optionTerm(option).length);
        }, 0);
      }
      /**
       * Get the longest argument term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestArgumentTermLength(cmd, helper) {
        return helper.visibleArguments(cmd).reduce((max, argument) => {
          return Math.max(max, helper.argumentTerm(argument).length);
        }, 0);
      }
      /**
       * Get the command usage to be displayed at the top of the built-in help.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandUsage(cmd) {
        let cmdName = cmd._name;
        if (cmd._aliases[0]) {
          cmdName = cmdName + "|" + cmd._aliases[0];
        }
        let ancestorCmdNames = "";
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
        }
        return ancestorCmdNames + cmdName + " " + cmd.usage();
      }
      /**
       * Get the description for the command.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandDescription(cmd) {
        return cmd.description();
      }
      /**
       * Get the subcommand summary to show in the list of subcommands.
       * (Fallback to description for backwards compatibility.)
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandDescription(cmd) {
        return cmd.summary() || cmd.description();
      }
      /**
       * Get the option description to show in the list of options.
       *
       * @param {Option} option
       * @return {string}
       */
      optionDescription(option) {
        const extraInfo = [];
        if (option.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (option.defaultValue !== void 0) {
          const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
          if (showDefault) {
            extraInfo.push(
              `default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`
            );
          }
        }
        if (option.presetArg !== void 0 && option.optional) {
          extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
        }
        if (option.envVar !== void 0) {
          extraInfo.push(`env: ${option.envVar}`);
        }
        if (extraInfo.length > 0) {
          return `${option.description} (${extraInfo.join(", ")})`;
        }
        return option.description;
      }
      /**
       * Get the argument description to show in the list of arguments.
       *
       * @param {Argument} argument
       * @return {string}
       */
      argumentDescription(argument) {
        const extraInfo = [];
        if (argument.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (argument.defaultValue !== void 0) {
          extraInfo.push(
            `default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`
          );
        }
        if (extraInfo.length > 0) {
          const extraDescripton = `(${extraInfo.join(", ")})`;
          if (argument.description) {
            return `${argument.description} ${extraDescripton}`;
          }
          return extraDescripton;
        }
        return argument.description;
      }
      /**
       * Generate the built-in help text.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {string}
       */
      formatHelp(cmd, helper) {
        const termWidth = helper.padWidth(cmd, helper);
        const helpWidth = helper.helpWidth || 80;
        const itemIndentWidth = 2;
        const itemSeparatorWidth = 2;
        function formatItem(term, description) {
          if (description) {
            const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
            return helper.wrap(
              fullText,
              helpWidth - itemIndentWidth,
              termWidth + itemSeparatorWidth
            );
          }
          return term;
        }
        function formatList(textArray) {
          return textArray.join("\n").replace(/^/gm, " ".repeat(itemIndentWidth));
        }
        let output = [`Usage: ${helper.commandUsage(cmd)}`, ""];
        const commandDescription = helper.commandDescription(cmd);
        if (commandDescription.length > 0) {
          output = output.concat([
            helper.wrap(commandDescription, helpWidth, 0),
            ""
          ]);
        }
        const argumentList = helper.visibleArguments(cmd).map((argument) => {
          return formatItem(
            helper.argumentTerm(argument),
            helper.argumentDescription(argument)
          );
        });
        if (argumentList.length > 0) {
          output = output.concat(["Arguments:", formatList(argumentList), ""]);
        }
        const optionList = helper.visibleOptions(cmd).map((option) => {
          return formatItem(
            helper.optionTerm(option),
            helper.optionDescription(option)
          );
        });
        if (optionList.length > 0) {
          output = output.concat(["Options:", formatList(optionList), ""]);
        }
        if (this.showGlobalOptions) {
          const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
            return formatItem(
              helper.optionTerm(option),
              helper.optionDescription(option)
            );
          });
          if (globalOptionList.length > 0) {
            output = output.concat([
              "Global Options:",
              formatList(globalOptionList),
              ""
            ]);
          }
        }
        const commandList = helper.visibleCommands(cmd).map((cmd2) => {
          return formatItem(
            helper.subcommandTerm(cmd2),
            helper.subcommandDescription(cmd2)
          );
        });
        if (commandList.length > 0) {
          output = output.concat(["Commands:", formatList(commandList), ""]);
        }
        return output.join("\n");
      }
      /**
       * Calculate the pad width from the maximum term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      padWidth(cmd, helper) {
        return Math.max(
          helper.longestOptionTermLength(cmd, helper),
          helper.longestGlobalOptionTermLength(cmd, helper),
          helper.longestSubcommandTermLength(cmd, helper),
          helper.longestArgumentTermLength(cmd, helper)
        );
      }
      /**
       * Wrap the given string to width characters per line, with lines after the first indented.
       * Do not wrap if insufficient room for wrapping (minColumnWidth), or string is manually formatted.
       *
       * @param {string} str
       * @param {number} width
       * @param {number} indent
       * @param {number} [minColumnWidth=40]
       * @return {string}
       *
       */
      wrap(str, width, indent, minColumnWidth = 40) {
        const indents = " \\f\\t\\v\xA0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF";
        const manualIndent = new RegExp(`[\\n][${indents}]+`);
        if (str.match(manualIndent))
          return str;
        const columnWidth = width - indent;
        if (columnWidth < minColumnWidth)
          return str;
        const leadingStr = str.slice(0, indent);
        const columnText = str.slice(indent).replace("\r\n", "\n");
        const indentString = " ".repeat(indent);
        const zeroWidthSpace = "\u200B";
        const breaks = `\\s${zeroWidthSpace}`;
        const regex = new RegExp(
          `
|.{1,${columnWidth - 1}}([${breaks}]|$)|[^${breaks}]+?([${breaks}]|$)`,
          "g"
        );
        const lines = columnText.match(regex) || [];
        return leadingStr + lines.map((line, i) => {
          if (line === "\n")
            return "";
          return (i > 0 ? indentString : "") + line.trimEnd();
        }).join("\n");
      }
    };
    exports2.Help = Help2;
  }
});

// node_modules/commander/lib/option.js
var require_option = __commonJS({
  "node_modules/commander/lib/option.js"(exports2) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Option2 = class {
      /**
       * Initialize a new `Option` with the given `flags` and `description`.
       *
       * @param {string} flags
       * @param {string} [description]
       */
      constructor(flags, description) {
        this.flags = flags;
        this.description = description || "";
        this.required = flags.includes("<");
        this.optional = flags.includes("[");
        this.variadic = /\w\.\.\.[>\]]$/.test(flags);
        this.mandatory = false;
        const optionFlags = splitOptionFlags(flags);
        this.short = optionFlags.shortFlag;
        this.long = optionFlags.longFlag;
        this.negate = false;
        if (this.long) {
          this.negate = this.long.startsWith("--no-");
        }
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.presetArg = void 0;
        this.envVar = void 0;
        this.parseArg = void 0;
        this.hidden = false;
        this.argChoices = void 0;
        this.conflictsWith = [];
        this.implied = void 0;
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Option}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Preset to use when option used without option-argument, especially optional but also boolean and negated.
       * The custom processing (parseArg) is called.
       *
       * @example
       * new Option('--color').default('GREYSCALE').preset('RGB');
       * new Option('--donate [amount]').preset('20').argParser(parseFloat);
       *
       * @param {*} arg
       * @return {Option}
       */
      preset(arg) {
        this.presetArg = arg;
        return this;
      }
      /**
       * Add option name(s) that conflict with this option.
       * An error will be displayed if conflicting options are found during parsing.
       *
       * @example
       * new Option('--rgb').conflicts('cmyk');
       * new Option('--js').conflicts(['ts', 'jsx']);
       *
       * @param {(string | string[])} names
       * @return {Option}
       */
      conflicts(names) {
        this.conflictsWith = this.conflictsWith.concat(names);
        return this;
      }
      /**
       * Specify implied option values for when this option is set and the implied options are not.
       *
       * The custom processing (parseArg) is not called on the implied values.
       *
       * @example
       * program
       *   .addOption(new Option('--log', 'write logging information to file'))
       *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
       *
       * @param {object} impliedOptionValues
       * @return {Option}
       */
      implies(impliedOptionValues) {
        let newImplied = impliedOptionValues;
        if (typeof impliedOptionValues === "string") {
          newImplied = { [impliedOptionValues]: true };
        }
        this.implied = Object.assign(this.implied || {}, newImplied);
        return this;
      }
      /**
       * Set environment variable to check for option value.
       *
       * An environment variable is only used if when processed the current option value is
       * undefined, or the source of the current value is 'default' or 'config' or 'env'.
       *
       * @param {string} name
       * @return {Option}
       */
      env(name) {
        this.envVar = name;
        return this;
      }
      /**
       * Set the custom handler for processing CLI option arguments into option values.
       *
       * @param {Function} [fn]
       * @return {Option}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Whether the option is mandatory and must have a value after parsing.
       *
       * @param {boolean} [mandatory=true]
       * @return {Option}
       */
      makeOptionMandatory(mandatory = true) {
        this.mandatory = !!mandatory;
        return this;
      }
      /**
       * Hide option in help.
       *
       * @param {boolean} [hide=true]
       * @return {Option}
       */
      hideHelp(hide = true) {
        this.hidden = !!hide;
        return this;
      }
      /**
       * @package
       */
      _concatValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        return previous.concat(value);
      }
      /**
       * Only allow option value to be one of choices.
       *
       * @param {string[]} values
       * @return {Option}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._concatValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Return option name.
       *
       * @return {string}
       */
      name() {
        if (this.long) {
          return this.long.replace(/^--/, "");
        }
        return this.short.replace(/^-/, "");
      }
      /**
       * Return option name, in a camelcase format that can be used
       * as a object attribute key.
       *
       * @return {string}
       */
      attributeName() {
        return camelcase(this.name().replace(/^no-/, ""));
      }
      /**
       * Check if `arg` matches the short or long flag.
       *
       * @param {string} arg
       * @return {boolean}
       * @package
       */
      is(arg) {
        return this.short === arg || this.long === arg;
      }
      /**
       * Return whether a boolean option.
       *
       * Options are one of boolean, negated, required argument, or optional argument.
       *
       * @return {boolean}
       * @package
       */
      isBoolean() {
        return !this.required && !this.optional && !this.negate;
      }
    };
    var DualOptions = class {
      /**
       * @param {Option[]} options
       */
      constructor(options) {
        this.positiveOptions = /* @__PURE__ */ new Map();
        this.negativeOptions = /* @__PURE__ */ new Map();
        this.dualOptions = /* @__PURE__ */ new Set();
        options.forEach((option) => {
          if (option.negate) {
            this.negativeOptions.set(option.attributeName(), option);
          } else {
            this.positiveOptions.set(option.attributeName(), option);
          }
        });
        this.negativeOptions.forEach((value, key) => {
          if (this.positiveOptions.has(key)) {
            this.dualOptions.add(key);
          }
        });
      }
      /**
       * Did the value come from the option, and not from possible matching dual option?
       *
       * @param {*} value
       * @param {Option} option
       * @returns {boolean}
       */
      valueFromOption(value, option) {
        const optionKey = option.attributeName();
        if (!this.dualOptions.has(optionKey))
          return true;
        const preset = this.negativeOptions.get(optionKey).presetArg;
        const negativeValue = preset !== void 0 ? preset : false;
        return option.negate === (negativeValue === value);
      }
    };
    function camelcase(str) {
      return str.split("-").reduce((str2, word) => {
        return str2 + word[0].toUpperCase() + word.slice(1);
      });
    }
    function splitOptionFlags(flags) {
      let shortFlag;
      let longFlag;
      const flagParts = flags.split(/[ |,]+/);
      if (flagParts.length > 1 && !/^[[<]/.test(flagParts[1]))
        shortFlag = flagParts.shift();
      longFlag = flagParts.shift();
      if (!shortFlag && /^-[^-]$/.test(longFlag)) {
        shortFlag = longFlag;
        longFlag = void 0;
      }
      return { shortFlag, longFlag };
    }
    exports2.Option = Option2;
    exports2.DualOptions = DualOptions;
  }
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS({
  "node_modules/commander/lib/suggestSimilar.js"(exports2) {
    var maxDistance = 3;
    function editDistance(a, b) {
      if (Math.abs(a.length - b.length) > maxDistance)
        return Math.max(a.length, b.length);
      const d = [];
      for (let i = 0; i <= a.length; i++) {
        d[i] = [i];
      }
      for (let j = 0; j <= b.length; j++) {
        d[0][j] = j;
      }
      for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
          let cost = 1;
          if (a[i - 1] === b[j - 1]) {
            cost = 0;
          } else {
            cost = 1;
          }
          d[i][j] = Math.min(
            d[i - 1][j] + 1,
            // deletion
            d[i][j - 1] + 1,
            // insertion
            d[i - 1][j - 1] + cost
            // substitution
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
          }
        }
      }
      return d[a.length][b.length];
    }
    function suggestSimilar(word, candidates) {
      if (!candidates || candidates.length === 0)
        return "";
      candidates = Array.from(new Set(candidates));
      const searchingOptions = word.startsWith("--");
      if (searchingOptions) {
        word = word.slice(2);
        candidates = candidates.map((candidate) => candidate.slice(2));
      }
      let similar = [];
      let bestDistance = maxDistance;
      const minSimilarity = 0.4;
      candidates.forEach((candidate) => {
        if (candidate.length <= 1)
          return;
        const distance = editDistance(word, candidate);
        const length = Math.max(word.length, candidate.length);
        const similarity = (length - distance) / length;
        if (similarity > minSimilarity) {
          if (distance < bestDistance) {
            bestDistance = distance;
            similar = [candidate];
          } else if (distance === bestDistance) {
            similar.push(candidate);
          }
        }
      });
      similar.sort((a, b) => a.localeCompare(b));
      if (searchingOptions) {
        similar = similar.map((candidate) => `--${candidate}`);
      }
      if (similar.length > 1) {
        return `
(Did you mean one of ${similar.join(", ")}?)`;
      }
      if (similar.length === 1) {
        return `
(Did you mean ${similar[0]}?)`;
      }
      return "";
    }
    exports2.suggestSimilar = suggestSimilar;
  }
});

// node_modules/commander/lib/command.js
var require_command = __commonJS({
  "node_modules/commander/lib/command.js"(exports2) {
    var EventEmitter = require("node:events").EventEmitter;
    var childProcess = require("node:child_process");
    var path8 = require("node:path");
    var fs8 = require("node:fs");
    var process2 = require("node:process");
    var { Argument: Argument2, humanReadableArgName } = require_argument();
    var { CommanderError: CommanderError2 } = require_error();
    var { Help: Help2 } = require_help();
    var { Option: Option2, DualOptions } = require_option();
    var { suggestSimilar } = require_suggestSimilar();
    var Command2 = class _Command extends EventEmitter {
      /**
       * Initialize a new `Command`.
       *
       * @param {string} [name]
       */
      constructor(name) {
        super();
        this.commands = [];
        this.options = [];
        this.parent = null;
        this._allowUnknownOption = false;
        this._allowExcessArguments = true;
        this.registeredArguments = [];
        this._args = this.registeredArguments;
        this.args = [];
        this.rawArgs = [];
        this.processedArgs = [];
        this._scriptPath = null;
        this._name = name || "";
        this._optionValues = {};
        this._optionValueSources = {};
        this._storeOptionsAsProperties = false;
        this._actionHandler = null;
        this._executableHandler = false;
        this._executableFile = null;
        this._executableDir = null;
        this._defaultCommandName = null;
        this._exitCallback = null;
        this._aliases = [];
        this._combineFlagAndOptionalValue = true;
        this._description = "";
        this._summary = "";
        this._argsDescription = void 0;
        this._enablePositionalOptions = false;
        this._passThroughOptions = false;
        this._lifeCycleHooks = {};
        this._showHelpAfterError = false;
        this._showSuggestionAfterError = true;
        this._outputConfiguration = {
          writeOut: (str) => process2.stdout.write(str),
          writeErr: (str) => process2.stderr.write(str),
          getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : void 0,
          getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : void 0,
          outputError: (str, write) => write(str)
        };
        this._hidden = false;
        this._helpOption = void 0;
        this._addImplicitHelpCommand = void 0;
        this._helpCommand = void 0;
        this._helpConfiguration = {};
      }
      /**
       * Copy settings that are useful to have in common across root command and subcommands.
       *
       * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
       *
       * @param {Command} sourceCommand
       * @return {Command} `this` command for chaining
       */
      copyInheritedSettings(sourceCommand) {
        this._outputConfiguration = sourceCommand._outputConfiguration;
        this._helpOption = sourceCommand._helpOption;
        this._helpCommand = sourceCommand._helpCommand;
        this._helpConfiguration = sourceCommand._helpConfiguration;
        this._exitCallback = sourceCommand._exitCallback;
        this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
        this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
        this._allowExcessArguments = sourceCommand._allowExcessArguments;
        this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
        this._showHelpAfterError = sourceCommand._showHelpAfterError;
        this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
        return this;
      }
      /**
       * @returns {Command[]}
       * @private
       */
      _getCommandAndAncestors() {
        const result = [];
        for (let command = this; command; command = command.parent) {
          result.push(command);
        }
        return result;
      }
      /**
       * Define a command.
       *
       * There are two styles of command: pay attention to where to put the description.
       *
       * @example
       * // Command implemented using action handler (description is supplied separately to `.command`)
       * program
       *   .command('clone <source> [destination]')
       *   .description('clone a repository into a newly created directory')
       *   .action((source, destination) => {
       *     console.log('clone command called');
       *   });
       *
       * // Command implemented using separate executable file (description is second parameter to `.command`)
       * program
       *   .command('start <service>', 'start named service')
       *   .command('stop [service]', 'stop named service, or all if no name supplied');
       *
       * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
       * @param {(object | string)} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
       * @param {object} [execOpts] - configuration options (for executable)
       * @return {Command} returns new command for action handler, or `this` for executable command
       */
      command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
        let desc = actionOptsOrExecDesc;
        let opts = execOpts;
        if (typeof desc === "object" && desc !== null) {
          opts = desc;
          desc = null;
        }
        opts = opts || {};
        const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
        const cmd = this.createCommand(name);
        if (desc) {
          cmd.description(desc);
          cmd._executableHandler = true;
        }
        if (opts.isDefault)
          this._defaultCommandName = cmd._name;
        cmd._hidden = !!(opts.noHelp || opts.hidden);
        cmd._executableFile = opts.executableFile || null;
        if (args)
          cmd.arguments(args);
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd.copyInheritedSettings(this);
        if (desc)
          return this;
        return cmd;
      }
      /**
       * Factory routine to create a new unattached command.
       *
       * See .command() for creating an attached subcommand, which uses this routine to
       * create the command. You can override createCommand to customise subcommands.
       *
       * @param {string} [name]
       * @return {Command} new command
       */
      createCommand(name) {
        return new _Command(name);
      }
      /**
       * You can customise the help with a subclass of Help by overriding createHelp,
       * or by overriding Help properties using configureHelp().
       *
       * @return {Help}
       */
      createHelp() {
        return Object.assign(new Help2(), this.configureHelp());
      }
      /**
       * You can customise the help by overriding Help properties using configureHelp(),
       * or with a subclass of Help by overriding createHelp().
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureHelp(configuration) {
        if (configuration === void 0)
          return this._helpConfiguration;
        this._helpConfiguration = configuration;
        return this;
      }
      /**
       * The default output goes to stdout and stderr. You can customise this for special
       * applications. You can also customise the display of errors by overriding outputError.
       *
       * The configuration properties are all functions:
       *
       *     // functions to change where being written, stdout and stderr
       *     writeOut(str)
       *     writeErr(str)
       *     // matching functions to specify width for wrapping help
       *     getOutHelpWidth()
       *     getErrHelpWidth()
       *     // functions based on what is being written out
       *     outputError(str, write) // used for displaying errors, and not used for displaying help
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureOutput(configuration) {
        if (configuration === void 0)
          return this._outputConfiguration;
        Object.assign(this._outputConfiguration, configuration);
        return this;
      }
      /**
       * Display the help or a custom message after an error occurs.
       *
       * @param {(boolean|string)} [displayHelp]
       * @return {Command} `this` command for chaining
       */
      showHelpAfterError(displayHelp = true) {
        if (typeof displayHelp !== "string")
          displayHelp = !!displayHelp;
        this._showHelpAfterError = displayHelp;
        return this;
      }
      /**
       * Display suggestion of similar commands for unknown commands, or options for unknown options.
       *
       * @param {boolean} [displaySuggestion]
       * @return {Command} `this` command for chaining
       */
      showSuggestionAfterError(displaySuggestion = true) {
        this._showSuggestionAfterError = !!displaySuggestion;
        return this;
      }
      /**
       * Add a prepared subcommand.
       *
       * See .command() for creating an attached subcommand which inherits settings from its parent.
       *
       * @param {Command} cmd - new subcommand
       * @param {object} [opts] - configuration options
       * @return {Command} `this` command for chaining
       */
      addCommand(cmd, opts) {
        if (!cmd._name) {
          throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
        }
        opts = opts || {};
        if (opts.isDefault)
          this._defaultCommandName = cmd._name;
        if (opts.noHelp || opts.hidden)
          cmd._hidden = true;
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd._checkForBrokenPassThrough();
        return this;
      }
      /**
       * Factory routine to create a new unattached argument.
       *
       * See .argument() for creating an attached argument, which uses this routine to
       * create the argument. You can override createArgument to return a custom argument.
       *
       * @param {string} name
       * @param {string} [description]
       * @return {Argument} new argument
       */
      createArgument(name, description) {
        return new Argument2(name, description);
      }
      /**
       * Define argument syntax for command.
       *
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @example
       * program.argument('<input-file>');
       * program.argument('[output-file]');
       *
       * @param {string} name
       * @param {string} [description]
       * @param {(Function|*)} [fn] - custom argument processing function
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      argument(name, description, fn, defaultValue) {
        const argument = this.createArgument(name, description);
        if (typeof fn === "function") {
          argument.default(defaultValue).argParser(fn);
        } else {
          argument.default(fn);
        }
        this.addArgument(argument);
        return this;
      }
      /**
       * Define argument syntax for command, adding multiple at once (without descriptions).
       *
       * See also .argument().
       *
       * @example
       * program.arguments('<cmd> [env]');
       *
       * @param {string} names
       * @return {Command} `this` command for chaining
       */
      arguments(names) {
        names.trim().split(/ +/).forEach((detail) => {
          this.argument(detail);
        });
        return this;
      }
      /**
       * Define argument syntax for command, adding a prepared argument.
       *
       * @param {Argument} argument
       * @return {Command} `this` command for chaining
       */
      addArgument(argument) {
        const previousArgument = this.registeredArguments.slice(-1)[0];
        if (previousArgument && previousArgument.variadic) {
          throw new Error(
            `only the last argument can be variadic '${previousArgument.name()}'`
          );
        }
        if (argument.required && argument.defaultValue !== void 0 && argument.parseArg === void 0) {
          throw new Error(
            `a default value for a required argument is never used: '${argument.name()}'`
          );
        }
        this.registeredArguments.push(argument);
        return this;
      }
      /**
       * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
       *
       * @example
       *    program.helpCommand('help [cmd]');
       *    program.helpCommand('help [cmd]', 'show help');
       *    program.helpCommand(false); // suppress default help command
       *    program.helpCommand(true); // add help command even if no subcommands
       *
       * @param {string|boolean} enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
       * @param {string} [description] - custom description
       * @return {Command} `this` command for chaining
       */
      helpCommand(enableOrNameAndArgs, description) {
        if (typeof enableOrNameAndArgs === "boolean") {
          this._addImplicitHelpCommand = enableOrNameAndArgs;
          return this;
        }
        enableOrNameAndArgs = enableOrNameAndArgs ?? "help [command]";
        const [, helpName, helpArgs] = enableOrNameAndArgs.match(/([^ ]+) *(.*)/);
        const helpDescription = description ?? "display help for command";
        const helpCommand = this.createCommand(helpName);
        helpCommand.helpOption(false);
        if (helpArgs)
          helpCommand.arguments(helpArgs);
        if (helpDescription)
          helpCommand.description(helpDescription);
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        return this;
      }
      /**
       * Add prepared custom help command.
       *
       * @param {(Command|string|boolean)} helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
       * @param {string} [deprecatedDescription] - deprecated custom description used with custom name only
       * @return {Command} `this` command for chaining
       */
      addHelpCommand(helpCommand, deprecatedDescription) {
        if (typeof helpCommand !== "object") {
          this.helpCommand(helpCommand, deprecatedDescription);
          return this;
        }
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        return this;
      }
      /**
       * Lazy create help command.
       *
       * @return {(Command|null)}
       * @package
       */
      _getHelpCommand() {
        const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
        if (hasImplicitHelpCommand) {
          if (this._helpCommand === void 0) {
            this.helpCommand(void 0, void 0);
          }
          return this._helpCommand;
        }
        return null;
      }
      /**
       * Add hook for life cycle event.
       *
       * @param {string} event
       * @param {Function} listener
       * @return {Command} `this` command for chaining
       */
      hook(event, listener) {
        const allowedValues = ["preSubcommand", "preAction", "postAction"];
        if (!allowedValues.includes(event)) {
          throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        if (this._lifeCycleHooks[event]) {
          this._lifeCycleHooks[event].push(listener);
        } else {
          this._lifeCycleHooks[event] = [listener];
        }
        return this;
      }
      /**
       * Register callback to use as replacement for calling process.exit.
       *
       * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
       * @return {Command} `this` command for chaining
       */
      exitOverride(fn) {
        if (fn) {
          this._exitCallback = fn;
        } else {
          this._exitCallback = (err) => {
            if (err.code !== "commander.executeSubCommandAsync") {
              throw err;
            } else {
            }
          };
        }
        return this;
      }
      /**
       * Call process.exit, and _exitCallback if defined.
       *
       * @param {number} exitCode exit code for using with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       * @return never
       * @private
       */
      _exit(exitCode, code, message) {
        if (this._exitCallback) {
          this._exitCallback(new CommanderError2(exitCode, code, message));
        }
        process2.exit(exitCode);
      }
      /**
       * Register callback `fn` for the command.
       *
       * @example
       * program
       *   .command('serve')
       *   .description('start service')
       *   .action(function() {
       *      // do work here
       *   });
       *
       * @param {Function} fn
       * @return {Command} `this` command for chaining
       */
      action(fn) {
        const listener = (args) => {
          const expectedArgsCount = this.registeredArguments.length;
          const actionArgs = args.slice(0, expectedArgsCount);
          if (this._storeOptionsAsProperties) {
            actionArgs[expectedArgsCount] = this;
          } else {
            actionArgs[expectedArgsCount] = this.opts();
          }
          actionArgs.push(this);
          return fn.apply(this, actionArgs);
        };
        this._actionHandler = listener;
        return this;
      }
      /**
       * Factory routine to create a new unattached option.
       *
       * See .option() for creating an attached option, which uses this routine to
       * create the option. You can override createOption to return a custom option.
       *
       * @param {string} flags
       * @param {string} [description]
       * @return {Option} new option
       */
      createOption(flags, description) {
        return new Option2(flags, description);
      }
      /**
       * Wrap parseArgs to catch 'commander.invalidArgument'.
       *
       * @param {(Option | Argument)} target
       * @param {string} value
       * @param {*} previous
       * @param {string} invalidArgumentMessage
       * @private
       */
      _callParseArg(target, value, previous, invalidArgumentMessage) {
        try {
          return target.parseArg(value, previous);
        } catch (err) {
          if (err.code === "commander.invalidArgument") {
            const message = `${invalidArgumentMessage} ${err.message}`;
            this.error(message, { exitCode: err.exitCode, code: err.code });
          }
          throw err;
        }
      }
      /**
       * Check for option flag conflicts.
       * Register option if no conflicts found, or throw on conflict.
       *
       * @param {Option} option
       * @private
       */
      _registerOption(option) {
        const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
        if (matchingOption) {
          const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
          throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
        }
        this.options.push(option);
      }
      /**
       * Check for command name and alias conflicts with existing commands.
       * Register command if no conflicts found, or throw on conflict.
       *
       * @param {Command} command
       * @private
       */
      _registerCommand(command) {
        const knownBy = (cmd) => {
          return [cmd.name()].concat(cmd.aliases());
        };
        const alreadyUsed = knownBy(command).find(
          (name) => this._findCommand(name)
        );
        if (alreadyUsed) {
          const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
          const newCmd = knownBy(command).join("|");
          throw new Error(
            `cannot add command '${newCmd}' as already have command '${existingCmd}'`
          );
        }
        this.commands.push(command);
      }
      /**
       * Add an option.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addOption(option) {
        this._registerOption(option);
        const oname = option.name();
        const name = option.attributeName();
        if (option.negate) {
          const positiveLongFlag = option.long.replace(/^--no-/, "--");
          if (!this._findOption(positiveLongFlag)) {
            this.setOptionValueWithSource(
              name,
              option.defaultValue === void 0 ? true : option.defaultValue,
              "default"
            );
          }
        } else if (option.defaultValue !== void 0) {
          this.setOptionValueWithSource(name, option.defaultValue, "default");
        }
        const handleOptionValue = (val, invalidValueMessage, valueSource) => {
          if (val == null && option.presetArg !== void 0) {
            val = option.presetArg;
          }
          const oldValue = this.getOptionValue(name);
          if (val !== null && option.parseArg) {
            val = this._callParseArg(option, val, oldValue, invalidValueMessage);
          } else if (val !== null && option.variadic) {
            val = option._concatValue(val, oldValue);
          }
          if (val == null) {
            if (option.negate) {
              val = false;
            } else if (option.isBoolean() || option.optional) {
              val = true;
            } else {
              val = "";
            }
          }
          this.setOptionValueWithSource(name, val, valueSource);
        };
        this.on("option:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "cli");
        });
        if (option.envVar) {
          this.on("optionEnv:" + oname, (val) => {
            const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
            handleOptionValue(val, invalidValueMessage, "env");
          });
        }
        return this;
      }
      /**
       * Internal implementation shared by .option() and .requiredOption()
       *
       * @return {Command} `this` command for chaining
       * @private
       */
      _optionEx(config, flags, description, fn, defaultValue) {
        if (typeof flags === "object" && flags instanceof Option2) {
          throw new Error(
            "To add an Option object use addOption() instead of option() or requiredOption()"
          );
        }
        const option = this.createOption(flags, description);
        option.makeOptionMandatory(!!config.mandatory);
        if (typeof fn === "function") {
          option.default(defaultValue).argParser(fn);
        } else if (fn instanceof RegExp) {
          const regex = fn;
          fn = (val, def) => {
            const m = regex.exec(val);
            return m ? m[0] : def;
          };
          option.default(defaultValue).argParser(fn);
        } else {
          option.default(fn);
        }
        return this.addOption(option);
      }
      /**
       * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
       * option-argument is indicated by `<>` and an optional option-argument by `[]`.
       *
       * See the README for more details, and see also addOption() and requiredOption().
       *
       * @example
       * program
       *     .option('-p, --pepper', 'add pepper')
       *     .option('-p, --pizza-type <TYPE>', 'type of pizza') // required option-argument
       *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
       *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      option(flags, description, parseArg, defaultValue) {
        return this._optionEx({}, flags, description, parseArg, defaultValue);
      }
      /**
       * Add a required option which must have a value after parsing. This usually means
       * the option must be specified on the command line. (Otherwise the same as .option().)
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      requiredOption(flags, description, parseArg, defaultValue) {
        return this._optionEx(
          { mandatory: true },
          flags,
          description,
          parseArg,
          defaultValue
        );
      }
      /**
       * Alter parsing of short flags with optional values.
       *
       * @example
       * // for `.option('-f,--flag [value]'):
       * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
       * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
       *
       * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
       * @return {Command} `this` command for chaining
       */
      combineFlagAndOptionalValue(combine = true) {
        this._combineFlagAndOptionalValue = !!combine;
        return this;
      }
      /**
       * Allow unknown options on the command line.
       *
       * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
       * @return {Command} `this` command for chaining
       */
      allowUnknownOption(allowUnknown = true) {
        this._allowUnknownOption = !!allowUnknown;
        return this;
      }
      /**
       * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
       *
       * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
       * @return {Command} `this` command for chaining
       */
      allowExcessArguments(allowExcess = true) {
        this._allowExcessArguments = !!allowExcess;
        return this;
      }
      /**
       * Enable positional options. Positional means global options are specified before subcommands which lets
       * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
       * The default behaviour is non-positional and global options may appear anywhere on the command line.
       *
       * @param {boolean} [positional]
       * @return {Command} `this` command for chaining
       */
      enablePositionalOptions(positional = true) {
        this._enablePositionalOptions = !!positional;
        return this;
      }
      /**
       * Pass through options that come after command-arguments rather than treat them as command-options,
       * so actual command-options come before command-arguments. Turning this on for a subcommand requires
       * positional options to have been enabled on the program (parent commands).
       * The default behaviour is non-positional and options may appear before or after command-arguments.
       *
       * @param {boolean} [passThrough] for unknown options.
       * @return {Command} `this` command for chaining
       */
      passThroughOptions(passThrough = true) {
        this._passThroughOptions = !!passThrough;
        this._checkForBrokenPassThrough();
        return this;
      }
      /**
       * @private
       */
      _checkForBrokenPassThrough() {
        if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
          throw new Error(
            `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`
          );
        }
      }
      /**
       * Whether to store option values as properties on command object,
       * or store separately (specify false). In both cases the option values can be accessed using .opts().
       *
       * @param {boolean} [storeAsProperties=true]
       * @return {Command} `this` command for chaining
       */
      storeOptionsAsProperties(storeAsProperties = true) {
        if (this.options.length) {
          throw new Error("call .storeOptionsAsProperties() before adding options");
        }
        if (Object.keys(this._optionValues).length) {
          throw new Error(
            "call .storeOptionsAsProperties() before setting option values"
          );
        }
        this._storeOptionsAsProperties = !!storeAsProperties;
        return this;
      }
      /**
       * Retrieve option value.
       *
       * @param {string} key
       * @return {object} value
       */
      getOptionValue(key) {
        if (this._storeOptionsAsProperties) {
          return this[key];
        }
        return this._optionValues[key];
      }
      /**
       * Store option value.
       *
       * @param {string} key
       * @param {object} value
       * @return {Command} `this` command for chaining
       */
      setOptionValue(key, value) {
        return this.setOptionValueWithSource(key, value, void 0);
      }
      /**
       * Store option value and where the value came from.
       *
       * @param {string} key
       * @param {object} value
       * @param {string} source - expected values are default/config/env/cli/implied
       * @return {Command} `this` command for chaining
       */
      setOptionValueWithSource(key, value, source) {
        if (this._storeOptionsAsProperties) {
          this[key] = value;
        } else {
          this._optionValues[key] = value;
        }
        this._optionValueSources[key] = source;
        return this;
      }
      /**
       * Get source of option value.
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSource(key) {
        return this._optionValueSources[key];
      }
      /**
       * Get source of option value. See also .optsWithGlobals().
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSourceWithGlobals(key) {
        let source;
        this._getCommandAndAncestors().forEach((cmd) => {
          if (cmd.getOptionValueSource(key) !== void 0) {
            source = cmd.getOptionValueSource(key);
          }
        });
        return source;
      }
      /**
       * Get user arguments from implied or explicit arguments.
       * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
       *
       * @private
       */
      _prepareUserArgs(argv, parseOptions) {
        if (argv !== void 0 && !Array.isArray(argv)) {
          throw new Error("first parameter to parse must be array or undefined");
        }
        parseOptions = parseOptions || {};
        if (argv === void 0 && parseOptions.from === void 0) {
          if (process2.versions?.electron) {
            parseOptions.from = "electron";
          }
          const execArgv = process2.execArgv ?? [];
          if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
            parseOptions.from = "eval";
          }
        }
        if (argv === void 0) {
          argv = process2.argv;
        }
        this.rawArgs = argv.slice();
        let userArgs;
        switch (parseOptions.from) {
          case void 0:
          case "node":
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
            break;
          case "electron":
            if (process2.defaultApp) {
              this._scriptPath = argv[1];
              userArgs = argv.slice(2);
            } else {
              userArgs = argv.slice(1);
            }
            break;
          case "user":
            userArgs = argv.slice(0);
            break;
          case "eval":
            userArgs = argv.slice(1);
            break;
          default:
            throw new Error(
              `unexpected parse option { from: '${parseOptions.from}' }`
            );
        }
        if (!this._name && this._scriptPath)
          this.nameFromFilename(this._scriptPath);
        this._name = this._name || "program";
        return userArgs;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Use parseAsync instead of parse if any of your action handlers are async.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * program.parse(); // parse process.argv and auto-detect electron and special node flags
       * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
       * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv] - optional, defaults to process.argv
       * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
       * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
       * @return {Command} `this` command for chaining
       */
      parse(argv, parseOptions) {
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        this._parseCommand([], userArgs);
        return this;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
       * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
       * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv]
       * @param {object} [parseOptions]
       * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
       * @return {Promise}
       */
      async parseAsync(argv, parseOptions) {
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        await this._parseCommand([], userArgs);
        return this;
      }
      /**
       * Execute a sub-command executable.
       *
       * @private
       */
      _executeSubCommand(subcommand, args) {
        args = args.slice();
        let launchWithNode = false;
        const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
        function findFile(baseDir, baseName) {
          const localBin = path8.resolve(baseDir, baseName);
          if (fs8.existsSync(localBin))
            return localBin;
          if (sourceExt.includes(path8.extname(baseName)))
            return void 0;
          const foundExt = sourceExt.find(
            (ext) => fs8.existsSync(`${localBin}${ext}`)
          );
          if (foundExt)
            return `${localBin}${foundExt}`;
          return void 0;
        }
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
        let executableDir = this._executableDir || "";
        if (this._scriptPath) {
          let resolvedScriptPath;
          try {
            resolvedScriptPath = fs8.realpathSync(this._scriptPath);
          } catch (err) {
            resolvedScriptPath = this._scriptPath;
          }
          executableDir = path8.resolve(
            path8.dirname(resolvedScriptPath),
            executableDir
          );
        }
        if (executableDir) {
          let localFile = findFile(executableDir, executableFile);
          if (!localFile && !subcommand._executableFile && this._scriptPath) {
            const legacyName = path8.basename(
              this._scriptPath,
              path8.extname(this._scriptPath)
            );
            if (legacyName !== this._name) {
              localFile = findFile(
                executableDir,
                `${legacyName}-${subcommand._name}`
              );
            }
          }
          executableFile = localFile || executableFile;
        }
        launchWithNode = sourceExt.includes(path8.extname(executableFile));
        let proc;
        if (process2.platform !== "win32") {
          if (launchWithNode) {
            args.unshift(executableFile);
            args = incrementNodeInspectorPort(process2.execArgv).concat(args);
            proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
          } else {
            proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
          }
        } else {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
        }
        if (!proc.killed) {
          const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
          signals.forEach((signal) => {
            process2.on(signal, () => {
              if (proc.killed === false && proc.exitCode === null) {
                proc.kill(signal);
              }
            });
          });
        }
        const exitCallback = this._exitCallback;
        proc.on("close", (code) => {
          code = code ?? 1;
          if (!exitCallback) {
            process2.exit(code);
          } else {
            exitCallback(
              new CommanderError2(
                code,
                "commander.executeSubCommandAsync",
                "(close)"
              )
            );
          }
        });
        proc.on("error", (err) => {
          if (err.code === "ENOENT") {
            const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
            const executableMissing = `'${executableFile}' does not exist
 - if '${subcommand._name}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
            throw new Error(executableMissing);
          } else if (err.code === "EACCES") {
            throw new Error(`'${executableFile}' not executable`);
          }
          if (!exitCallback) {
            process2.exit(1);
          } else {
            const wrappedError = new CommanderError2(
              1,
              "commander.executeSubCommandAsync",
              "(error)"
            );
            wrappedError.nestedError = err;
            exitCallback(wrappedError);
          }
        });
        this.runningCommand = proc;
      }
      /**
       * @private
       */
      _dispatchSubcommand(commandName, operands, unknown) {
        const subCommand = this._findCommand(commandName);
        if (!subCommand)
          this.help({ error: true });
        let promiseChain;
        promiseChain = this._chainOrCallSubCommandHook(
          promiseChain,
          subCommand,
          "preSubcommand"
        );
        promiseChain = this._chainOrCall(promiseChain, () => {
          if (subCommand._executableHandler) {
            this._executeSubCommand(subCommand, operands.concat(unknown));
          } else {
            return subCommand._parseCommand(operands, unknown);
          }
        });
        return promiseChain;
      }
      /**
       * Invoke help directly if possible, or dispatch if necessary.
       * e.g. help foo
       *
       * @private
       */
      _dispatchHelpCommand(subcommandName) {
        if (!subcommandName) {
          this.help();
        }
        const subCommand = this._findCommand(subcommandName);
        if (subCommand && !subCommand._executableHandler) {
          subCommand.help();
        }
        return this._dispatchSubcommand(
          subcommandName,
          [],
          [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]
        );
      }
      /**
       * Check this.args against expected this.registeredArguments.
       *
       * @private
       */
      _checkNumberOfArguments() {
        this.registeredArguments.forEach((arg, i) => {
          if (arg.required && this.args[i] == null) {
            this.missingArgument(arg.name());
          }
        });
        if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
          return;
        }
        if (this.args.length > this.registeredArguments.length) {
          this._excessArguments(this.args);
        }
      }
      /**
       * Process this.args using this.registeredArguments and save as this.processedArgs!
       *
       * @private
       */
      _processArguments() {
        const myParseArg = (argument, value, previous) => {
          let parsedValue = value;
          if (value !== null && argument.parseArg) {
            const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
            parsedValue = this._callParseArg(
              argument,
              value,
              previous,
              invalidValueMessage
            );
          }
          return parsedValue;
        };
        this._checkNumberOfArguments();
        const processedArgs = [];
        this.registeredArguments.forEach((declaredArg, index) => {
          let value = declaredArg.defaultValue;
          if (declaredArg.variadic) {
            if (index < this.args.length) {
              value = this.args.slice(index);
              if (declaredArg.parseArg) {
                value = value.reduce((processed, v) => {
                  return myParseArg(declaredArg, v, processed);
                }, declaredArg.defaultValue);
              }
            } else if (value === void 0) {
              value = [];
            }
          } else if (index < this.args.length) {
            value = this.args[index];
            if (declaredArg.parseArg) {
              value = myParseArg(declaredArg, value, declaredArg.defaultValue);
            }
          }
          processedArgs[index] = value;
        });
        this.processedArgs = processedArgs;
      }
      /**
       * Once we have a promise we chain, but call synchronously until then.
       *
       * @param {(Promise|undefined)} promise
       * @param {Function} fn
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCall(promise, fn) {
        if (promise && promise.then && typeof promise.then === "function") {
          return promise.then(() => fn());
        }
        return fn();
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallHooks(promise, event) {
        let result = promise;
        const hooks = [];
        this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== void 0).forEach((hookedCommand) => {
          hookedCommand._lifeCycleHooks[event].forEach((callback) => {
            hooks.push({ hookedCommand, callback });
          });
        });
        if (event === "postAction") {
          hooks.reverse();
        }
        hooks.forEach((hookDetail) => {
          result = this._chainOrCall(result, () => {
            return hookDetail.callback(hookDetail.hookedCommand, this);
          });
        });
        return result;
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {Command} subCommand
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallSubCommandHook(promise, subCommand, event) {
        let result = promise;
        if (this._lifeCycleHooks[event] !== void 0) {
          this._lifeCycleHooks[event].forEach((hook) => {
            result = this._chainOrCall(result, () => {
              return hook(this, subCommand);
            });
          });
        }
        return result;
      }
      /**
       * Process arguments in context of this command.
       * Returns action result, in case it is a promise.
       *
       * @private
       */
      _parseCommand(operands, unknown) {
        const parsed = this.parseOptions(unknown);
        this._parseOptionsEnv();
        this._parseOptionsImplied();
        operands = operands.concat(parsed.operands);
        unknown = parsed.unknown;
        this.args = operands.concat(unknown);
        if (operands && this._findCommand(operands[0])) {
          return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
        }
        if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
          return this._dispatchHelpCommand(operands[1]);
        }
        if (this._defaultCommandName) {
          this._outputHelpIfRequested(unknown);
          return this._dispatchSubcommand(
            this._defaultCommandName,
            operands,
            unknown
          );
        }
        if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
          this.help({ error: true });
        }
        this._outputHelpIfRequested(parsed.unknown);
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        const checkForUnknownOptions = () => {
          if (parsed.unknown.length > 0) {
            this.unknownOption(parsed.unknown[0]);
          }
        };
        const commandEvent = `command:${this.name()}`;
        if (this._actionHandler) {
          checkForUnknownOptions();
          this._processArguments();
          let promiseChain;
          promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
          promiseChain = this._chainOrCall(
            promiseChain,
            () => this._actionHandler(this.processedArgs)
          );
          if (this.parent) {
            promiseChain = this._chainOrCall(promiseChain, () => {
              this.parent.emit(commandEvent, operands, unknown);
            });
          }
          promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
          return promiseChain;
        }
        if (this.parent && this.parent.listenerCount(commandEvent)) {
          checkForUnknownOptions();
          this._processArguments();
          this.parent.emit(commandEvent, operands, unknown);
        } else if (operands.length) {
          if (this._findCommand("*")) {
            return this._dispatchSubcommand("*", operands, unknown);
          }
          if (this.listenerCount("command:*")) {
            this.emit("command:*", operands, unknown);
          } else if (this.commands.length) {
            this.unknownCommand();
          } else {
            checkForUnknownOptions();
            this._processArguments();
          }
        } else if (this.commands.length) {
          checkForUnknownOptions();
          this.help({ error: true });
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      }
      /**
       * Find matching command.
       *
       * @private
       * @return {Command | undefined}
       */
      _findCommand(name) {
        if (!name)
          return void 0;
        return this.commands.find(
          (cmd) => cmd._name === name || cmd._aliases.includes(name)
        );
      }
      /**
       * Return an option matching `arg` if any.
       *
       * @param {string} arg
       * @return {Option}
       * @package
       */
      _findOption(arg) {
        return this.options.find((option) => option.is(arg));
      }
      /**
       * Display an error message if a mandatory option does not have a value.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForMissingMandatoryOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd.options.forEach((anOption) => {
            if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === void 0) {
              cmd.missingMandatoryOptionValue(anOption);
            }
          });
        });
      }
      /**
       * Display an error message if conflicting options are used together in this.
       *
       * @private
       */
      _checkForConflictingLocalOptions() {
        const definedNonDefaultOptions = this.options.filter((option) => {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === void 0) {
            return false;
          }
          return this.getOptionValueSource(optionKey) !== "default";
        });
        const optionsWithConflicting = definedNonDefaultOptions.filter(
          (option) => option.conflictsWith.length > 0
        );
        optionsWithConflicting.forEach((option) => {
          const conflictingAndDefined = definedNonDefaultOptions.find(
            (defined) => option.conflictsWith.includes(defined.attributeName())
          );
          if (conflictingAndDefined) {
            this._conflictingOption(option, conflictingAndDefined);
          }
        });
      }
      /**
       * Display an error message if conflicting options are used together.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForConflictingOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd._checkForConflictingLocalOptions();
        });
      }
      /**
       * Parse options from `argv` removing known options,
       * and return argv split into operands and unknown arguments.
       *
       * Examples:
       *
       *     argv => operands, unknown
       *     --known kkk op => [op], []
       *     op --known kkk => [op], []
       *     sub --unknown uuu op => [sub], [--unknown uuu op]
       *     sub -- --unknown uuu op => [sub --unknown uuu op], []
       *
       * @param {string[]} argv
       * @return {{operands: string[], unknown: string[]}}
       */
      parseOptions(argv) {
        const operands = [];
        const unknown = [];
        let dest = operands;
        const args = argv.slice();
        function maybeOption(arg) {
          return arg.length > 1 && arg[0] === "-";
        }
        let activeVariadicOption = null;
        while (args.length) {
          const arg = args.shift();
          if (arg === "--") {
            if (dest === unknown)
              dest.push(arg);
            dest.push(...args);
            break;
          }
          if (activeVariadicOption && !maybeOption(arg)) {
            this.emit(`option:${activeVariadicOption.name()}`, arg);
            continue;
          }
          activeVariadicOption = null;
          if (maybeOption(arg)) {
            const option = this._findOption(arg);
            if (option) {
              if (option.required) {
                const value = args.shift();
                if (value === void 0)
                  this.optionMissingArgument(option);
                this.emit(`option:${option.name()}`, value);
              } else if (option.optional) {
                let value = null;
                if (args.length > 0 && !maybeOption(args[0])) {
                  value = args.shift();
                }
                this.emit(`option:${option.name()}`, value);
              } else {
                this.emit(`option:${option.name()}`);
              }
              activeVariadicOption = option.variadic ? option : null;
              continue;
            }
          }
          if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
            const option = this._findOption(`-${arg[1]}`);
            if (option) {
              if (option.required || option.optional && this._combineFlagAndOptionalValue) {
                this.emit(`option:${option.name()}`, arg.slice(2));
              } else {
                this.emit(`option:${option.name()}`);
                args.unshift(`-${arg.slice(2)}`);
              }
              continue;
            }
          }
          if (/^--[^=]+=/.test(arg)) {
            const index = arg.indexOf("=");
            const option = this._findOption(arg.slice(0, index));
            if (option && (option.required || option.optional)) {
              this.emit(`option:${option.name()}`, arg.slice(index + 1));
              continue;
            }
          }
          if (maybeOption(arg)) {
            dest = unknown;
          }
          if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
            if (this._findCommand(arg)) {
              operands.push(arg);
              if (args.length > 0)
                unknown.push(...args);
              break;
            } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
              operands.push(arg);
              if (args.length > 0)
                operands.push(...args);
              break;
            } else if (this._defaultCommandName) {
              unknown.push(arg);
              if (args.length > 0)
                unknown.push(...args);
              break;
            }
          }
          if (this._passThroughOptions) {
            dest.push(arg);
            if (args.length > 0)
              dest.push(...args);
            break;
          }
          dest.push(arg);
        }
        return { operands, unknown };
      }
      /**
       * Return an object containing local option values as key-value pairs.
       *
       * @return {object}
       */
      opts() {
        if (this._storeOptionsAsProperties) {
          const result = {};
          const len = this.options.length;
          for (let i = 0; i < len; i++) {
            const key = this.options[i].attributeName();
            result[key] = key === this._versionOptionName ? this._version : this[key];
          }
          return result;
        }
        return this._optionValues;
      }
      /**
       * Return an object containing merged local and global option values as key-value pairs.
       *
       * @return {object}
       */
      optsWithGlobals() {
        return this._getCommandAndAncestors().reduce(
          (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
          {}
        );
      }
      /**
       * Display error message and exit (or call exitOverride).
       *
       * @param {string} message
       * @param {object} [errorOptions]
       * @param {string} [errorOptions.code] - an id string representing the error
       * @param {number} [errorOptions.exitCode] - used with process.exit
       */
      error(message, errorOptions) {
        this._outputConfiguration.outputError(
          `${message}
`,
          this._outputConfiguration.writeErr
        );
        if (typeof this._showHelpAfterError === "string") {
          this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
        } else if (this._showHelpAfterError) {
          this._outputConfiguration.writeErr("\n");
          this.outputHelp({ error: true });
        }
        const config = errorOptions || {};
        const exitCode = config.exitCode || 1;
        const code = config.code || "commander.error";
        this._exit(exitCode, code, message);
      }
      /**
       * Apply any option related environment variables, if option does
       * not have a value from cli or client code.
       *
       * @private
       */
      _parseOptionsEnv() {
        this.options.forEach((option) => {
          if (option.envVar && option.envVar in process2.env) {
            const optionKey = option.attributeName();
            if (this.getOptionValue(optionKey) === void 0 || ["default", "config", "env"].includes(
              this.getOptionValueSource(optionKey)
            )) {
              if (option.required || option.optional) {
                this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
              } else {
                this.emit(`optionEnv:${option.name()}`);
              }
            }
          }
        });
      }
      /**
       * Apply any implied option values, if option is undefined or default value.
       *
       * @private
       */
      _parseOptionsImplied() {
        const dualHelper = new DualOptions(this.options);
        const hasCustomOptionValue = (optionKey) => {
          return this.getOptionValue(optionKey) !== void 0 && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
        };
        this.options.filter(
          (option) => option.implied !== void 0 && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(
            this.getOptionValue(option.attributeName()),
            option
          )
        ).forEach((option) => {
          Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
            this.setOptionValueWithSource(
              impliedKey,
              option.implied[impliedKey],
              "implied"
            );
          });
        });
      }
      /**
       * Argument `name` is missing.
       *
       * @param {string} name
       * @private
       */
      missingArgument(name) {
        const message = `error: missing required argument '${name}'`;
        this.error(message, { code: "commander.missingArgument" });
      }
      /**
       * `Option` is missing an argument.
       *
       * @param {Option} option
       * @private
       */
      optionMissingArgument(option) {
        const message = `error: option '${option.flags}' argument missing`;
        this.error(message, { code: "commander.optionMissingArgument" });
      }
      /**
       * `Option` does not have a value, and is a mandatory option.
       *
       * @param {Option} option
       * @private
       */
      missingMandatoryOptionValue(option) {
        const message = `error: required option '${option.flags}' not specified`;
        this.error(message, { code: "commander.missingMandatoryOptionValue" });
      }
      /**
       * `Option` conflicts with another option.
       *
       * @param {Option} option
       * @param {Option} conflictingOption
       * @private
       */
      _conflictingOption(option, conflictingOption) {
        const findBestOptionFromValue = (option2) => {
          const optionKey = option2.attributeName();
          const optionValue = this.getOptionValue(optionKey);
          const negativeOption = this.options.find(
            (target) => target.negate && optionKey === target.attributeName()
          );
          const positiveOption = this.options.find(
            (target) => !target.negate && optionKey === target.attributeName()
          );
          if (negativeOption && (negativeOption.presetArg === void 0 && optionValue === false || negativeOption.presetArg !== void 0 && optionValue === negativeOption.presetArg)) {
            return negativeOption;
          }
          return positiveOption || option2;
        };
        const getErrorMessage = (option2) => {
          const bestOption = findBestOptionFromValue(option2);
          const optionKey = bestOption.attributeName();
          const source = this.getOptionValueSource(optionKey);
          if (source === "env") {
            return `environment variable '${bestOption.envVar}'`;
          }
          return `option '${bestOption.flags}'`;
        };
        const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
        this.error(message, { code: "commander.conflictingOption" });
      }
      /**
       * Unknown option `flag`.
       *
       * @param {string} flag
       * @private
       */
      unknownOption(flag) {
        if (this._allowUnknownOption)
          return;
        let suggestion = "";
        if (flag.startsWith("--") && this._showSuggestionAfterError) {
          let candidateFlags = [];
          let command = this;
          do {
            const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
            candidateFlags = candidateFlags.concat(moreFlags);
            command = command.parent;
          } while (command && !command._enablePositionalOptions);
          suggestion = suggestSimilar(flag, candidateFlags);
        }
        const message = `error: unknown option '${flag}'${suggestion}`;
        this.error(message, { code: "commander.unknownOption" });
      }
      /**
       * Excess arguments, more than expected.
       *
       * @param {string[]} receivedArgs
       * @private
       */
      _excessArguments(receivedArgs) {
        if (this._allowExcessArguments)
          return;
        const expected = this.registeredArguments.length;
        const s = expected === 1 ? "" : "s";
        const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
        const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
        this.error(message, { code: "commander.excessArguments" });
      }
      /**
       * Unknown command.
       *
       * @private
       */
      unknownCommand() {
        const unknownName = this.args[0];
        let suggestion = "";
        if (this._showSuggestionAfterError) {
          const candidateNames = [];
          this.createHelp().visibleCommands(this).forEach((command) => {
            candidateNames.push(command.name());
            if (command.alias())
              candidateNames.push(command.alias());
          });
          suggestion = suggestSimilar(unknownName, candidateNames);
        }
        const message = `error: unknown command '${unknownName}'${suggestion}`;
        this.error(message, { code: "commander.unknownCommand" });
      }
      /**
       * Get or set the program version.
       *
       * This method auto-registers the "-V, --version" option which will print the version number.
       *
       * You can optionally supply the flags and description to override the defaults.
       *
       * @param {string} [str]
       * @param {string} [flags]
       * @param {string} [description]
       * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
       */
      version(str, flags, description) {
        if (str === void 0)
          return this._version;
        this._version = str;
        flags = flags || "-V, --version";
        description = description || "output the version number";
        const versionOption = this.createOption(flags, description);
        this._versionOptionName = versionOption.attributeName();
        this._registerOption(versionOption);
        this.on("option:" + versionOption.name(), () => {
          this._outputConfiguration.writeOut(`${str}
`);
          this._exit(0, "commander.version", str);
        });
        return this;
      }
      /**
       * Set the description.
       *
       * @param {string} [str]
       * @param {object} [argsDescription]
       * @return {(string|Command)}
       */
      description(str, argsDescription) {
        if (str === void 0 && argsDescription === void 0)
          return this._description;
        this._description = str;
        if (argsDescription) {
          this._argsDescription = argsDescription;
        }
        return this;
      }
      /**
       * Set the summary. Used when listed as subcommand of parent.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      summary(str) {
        if (str === void 0)
          return this._summary;
        this._summary = str;
        return this;
      }
      /**
       * Set an alias for the command.
       *
       * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
       *
       * @param {string} [alias]
       * @return {(string|Command)}
       */
      alias(alias) {
        if (alias === void 0)
          return this._aliases[0];
        let command = this;
        if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
          command = this.commands[this.commands.length - 1];
        }
        if (alias === command._name)
          throw new Error("Command alias can't be the same as its name");
        const matchingCommand = this.parent?._findCommand(alias);
        if (matchingCommand) {
          const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
          throw new Error(
            `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`
          );
        }
        command._aliases.push(alias);
        return this;
      }
      /**
       * Set aliases for the command.
       *
       * Only the first alias is shown in the auto-generated help.
       *
       * @param {string[]} [aliases]
       * @return {(string[]|Command)}
       */
      aliases(aliases) {
        if (aliases === void 0)
          return this._aliases;
        aliases.forEach((alias) => this.alias(alias));
        return this;
      }
      /**
       * Set / get the command usage `str`.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      usage(str) {
        if (str === void 0) {
          if (this._usage)
            return this._usage;
          const args = this.registeredArguments.map((arg) => {
            return humanReadableArgName(arg);
          });
          return [].concat(
            this.options.length || this._helpOption !== null ? "[options]" : [],
            this.commands.length ? "[command]" : [],
            this.registeredArguments.length ? args : []
          ).join(" ");
        }
        this._usage = str;
        return this;
      }
      /**
       * Get or set the name of the command.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      name(str) {
        if (str === void 0)
          return this._name;
        this._name = str;
        return this;
      }
      /**
       * Set the name of the command from script filename, such as process.argv[1],
       * or require.main.filename, or __filename.
       *
       * (Used internally and public although not documented in README.)
       *
       * @example
       * program.nameFromFilename(require.main.filename);
       *
       * @param {string} filename
       * @return {Command}
       */
      nameFromFilename(filename) {
        this._name = path8.basename(filename, path8.extname(filename));
        return this;
      }
      /**
       * Get or set the directory for searching for executable subcommands of this command.
       *
       * @example
       * program.executableDir(__dirname);
       * // or
       * program.executableDir('subcommands');
       *
       * @param {string} [path]
       * @return {(string|null|Command)}
       */
      executableDir(path9) {
        if (path9 === void 0)
          return this._executableDir;
        this._executableDir = path9;
        return this;
      }
      /**
       * Return program help documentation.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to wrap for stderr instead of stdout
       * @return {string}
       */
      helpInformation(contextOptions) {
        const helper = this.createHelp();
        if (helper.helpWidth === void 0) {
          helper.helpWidth = contextOptions && contextOptions.error ? this._outputConfiguration.getErrHelpWidth() : this._outputConfiguration.getOutHelpWidth();
        }
        return helper.formatHelp(this, helper);
      }
      /**
       * @private
       */
      _getHelpContext(contextOptions) {
        contextOptions = contextOptions || {};
        const context = { error: !!contextOptions.error };
        let write;
        if (context.error) {
          write = (arg) => this._outputConfiguration.writeErr(arg);
        } else {
          write = (arg) => this._outputConfiguration.writeOut(arg);
        }
        context.write = contextOptions.write || write;
        context.command = this;
        return context;
      }
      /**
       * Output help information for this command.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean } | Function} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      outputHelp(contextOptions) {
        let deprecatedCallback;
        if (typeof contextOptions === "function") {
          deprecatedCallback = contextOptions;
          contextOptions = void 0;
        }
        const context = this._getHelpContext(contextOptions);
        this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", context));
        this.emit("beforeHelp", context);
        let helpInformation = this.helpInformation(context);
        if (deprecatedCallback) {
          helpInformation = deprecatedCallback(helpInformation);
          if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
            throw new Error("outputHelp callback must return a string or a Buffer");
          }
        }
        context.write(helpInformation);
        if (this._getHelpOption()?.long) {
          this.emit(this._getHelpOption().long);
        }
        this.emit("afterHelp", context);
        this._getCommandAndAncestors().forEach(
          (command) => command.emit("afterAllHelp", context)
        );
      }
      /**
       * You can pass in flags and a description to customise the built-in help option.
       * Pass in false to disable the built-in help option.
       *
       * @example
       * program.helpOption('-?, --help' 'show help'); // customise
       * program.helpOption(false); // disable
       *
       * @param {(string | boolean)} flags
       * @param {string} [description]
       * @return {Command} `this` command for chaining
       */
      helpOption(flags, description) {
        if (typeof flags === "boolean") {
          if (flags) {
            this._helpOption = this._helpOption ?? void 0;
          } else {
            this._helpOption = null;
          }
          return this;
        }
        flags = flags ?? "-h, --help";
        description = description ?? "display help for command";
        this._helpOption = this.createOption(flags, description);
        return this;
      }
      /**
       * Lazy create help option.
       * Returns null if has been disabled with .helpOption(false).
       *
       * @returns {(Option | null)} the help option
       * @package
       */
      _getHelpOption() {
        if (this._helpOption === void 0) {
          this.helpOption(void 0, void 0);
        }
        return this._helpOption;
      }
      /**
       * Supply your own option to use for the built-in help option.
       * This is an alternative to using helpOption() to customise the flags and description etc.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addHelpOption(option) {
        this._helpOption = option;
        return this;
      }
      /**
       * Output help information and exit.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      help(contextOptions) {
        this.outputHelp(contextOptions);
        let exitCode = process2.exitCode || 0;
        if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
          exitCode = 1;
        }
        this._exit(exitCode, "commander.help", "(outputHelp)");
      }
      /**
       * Add additional text to be displayed with the built-in help.
       *
       * Position is 'before' or 'after' to affect just this command,
       * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
       *
       * @param {string} position - before or after built-in help
       * @param {(string | Function)} text - string to add, or a function returning a string
       * @return {Command} `this` command for chaining
       */
      addHelpText(position, text) {
        const allowedValues = ["beforeAll", "before", "after", "afterAll"];
        if (!allowedValues.includes(position)) {
          throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        const helpEvent = `${position}Help`;
        this.on(helpEvent, (context) => {
          let helpStr;
          if (typeof text === "function") {
            helpStr = text({ error: context.error, command: context.command });
          } else {
            helpStr = text;
          }
          if (helpStr) {
            context.write(`${helpStr}
`);
          }
        });
        return this;
      }
      /**
       * Output help information if help flags specified
       *
       * @param {Array} args - array of options to search for help flags
       * @private
       */
      _outputHelpIfRequested(args) {
        const helpOption = this._getHelpOption();
        const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
        if (helpRequested) {
          this.outputHelp();
          this._exit(0, "commander.helpDisplayed", "(outputHelp)");
        }
      }
    };
    function incrementNodeInspectorPort(args) {
      return args.map((arg) => {
        if (!arg.startsWith("--inspect")) {
          return arg;
        }
        let debugOption;
        let debugHost = "127.0.0.1";
        let debugPort = "9229";
        let match;
        if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
          debugOption = match[1];
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
          debugOption = match[1];
          if (/^\d+$/.test(match[3])) {
            debugPort = match[3];
          } else {
            debugHost = match[3];
          }
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
          debugOption = match[1];
          debugHost = match[3];
          debugPort = match[4];
        }
        if (debugOption && debugPort !== "0") {
          return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
        }
        return arg;
      });
    }
    exports2.Command = Command2;
  }
});

// node_modules/commander/index.js
var require_commander = __commonJS({
  "node_modules/commander/index.js"(exports2) {
    var { Argument: Argument2 } = require_argument();
    var { Command: Command2 } = require_command();
    var { CommanderError: CommanderError2, InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var { Help: Help2 } = require_help();
    var { Option: Option2 } = require_option();
    exports2.program = new Command2();
    exports2.createCommand = (name) => new Command2(name);
    exports2.createOption = (flags, description) => new Option2(flags, description);
    exports2.createArgument = (name, description) => new Argument2(name, description);
    exports2.Command = Command2;
    exports2.Option = Option2;
    exports2.Argument = Argument2;
    exports2.Help = Help2;
    exports2.CommanderError = CommanderError2;
    exports2.InvalidArgumentError = InvalidArgumentError2;
    exports2.InvalidOptionArgumentError = InvalidArgumentError2;
  }
});

// src/auth.ts
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = (0, import_node_child_process.execFile)(cmd, [...args], (err) => resolve(!err));
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
async function ensureAuthorized(provider, io = defaultAuthIO) {
  if (await provider.isAuthorized()) {
    io.ok(`${provider.name} autorizado`);
    return true;
  }
  const message = provider.prompt ?? `${provider.name} precisa ser autorizado nesta m\xE1quina. Pressione ENTER para continuar\u2026`;
  await io.waitForEnter(message);
  await provider.authorize();
  if (await provider.isAuthorized()) {
    io.ok(`${provider.name} autorizado`);
    return true;
  }
  return false;
}
var import_node_child_process, import_node_readline, defaultAuthIO;
var init_auth = __esm({
  "src/auth.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_readline = __toESM(require("node:readline"));
    defaultAuthIO = {
      ok: (m) => console.log(`\u2713 ${m}`),
      info: (m) => console.log(m),
      waitForEnter: (message) => new Promise((resolve) => {
        if (!process.stdin.isTTY) {
          console.log(message);
          resolve();
          return;
        }
        const rl = import_node_readline.default.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        rl.question(`${message} `, () => {
          rl.close();
          resolve();
        });
      })
    };
  }
});

// src/keychain.ts
var keychain_exports = {};
__export(keychain_exports, {
  accountFor: () => accountFor,
  keychainAddScript: () => keychainAddScript,
  keychainGetScript: () => keychainGetScript,
  keychainRemoveScript: () => keychainRemoveScript,
  keychainScriptEnv: () => keychainScriptEnv,
  keychainService: () => keychainService,
  osascriptArgs: () => osascriptArgs,
  resolveKeychain: () => resolveKeychain
});
function keychainService() {
  return SERVICE;
}
function accountFor(projectId) {
  return `project:${projectId}`;
}
function keychainAddScript() {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
${JXA_HELPERS}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
var secret = env('SUPREMO_KC_SECRET')
if (!account || !service || !secret) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE/SECRET ausentes na env do processo.')
}
$.SecItemDelete(baseQuery(account, service)) // idempotente: substitui se j\xE1 existir
var data = cfstr(secret).dataUsingEncoding($.NSUTF8StringEncoding)
var addQuery = baseQuery(account, service)
addQuery.setObjectForKey(data, cfstr('v_Data'))
var status = $.SecItemAdd(addQuery, $())
if (status !== 0) { throw new Error('SecItemAdd falhou: status ' + status) }
`.trim();
}
function keychainGetScript() {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
ObjC.bindFunction('SecItemCopyMatching', ['i', ['@', '^@']])
${JXA_HELPERS}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
if (!account || !service) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE ausentes na env do processo.')
}
var query = baseQuery(account, service)
query.setObjectForKey($.NSNumber.numberWithBool(true), cfstr('r_Data'))
var result = Ref()
var status = $.SecItemCopyMatching(query, result)
if (status === 0) {
  var str = $.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding))
} else if (status === -25300) {
  // errSecItemNotFound: sem sa\xEDda \u2014 macGet devolve null
} else {
  throw new Error('SecItemCopyMatching falhou: status ' + status)
}
`.trim();
}
function keychainRemoveScript() {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
${JXA_HELPERS}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
if (!account || !service) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE ausentes na env do processo.')
}
$.SecItemDelete(baseQuery(account, service))
`.trim();
}
function osascriptArgs(scriptPath) {
  return { cmd: "osascript", args: ["-l", "JavaScript", scriptPath] };
}
function keychainScriptEnv(base, fields) {
  return {
    ...base,
    SUPREMO_KC_ACCOUNT: fields.account,
    SUPREMO_KC_SERVICE: fields.service,
    ...fields.secret !== void 0 ? { SUPREMO_KC_SECRET: fields.secret } : {}
  };
}
function runKeychainScript(script, env) {
  const scriptPath = import_node_path.default.join(
    import_node_os.default.tmpdir(),
    `supremo-kc-${import_node_crypto.default.randomBytes(8).toString("hex")}.js`
  );
  import_node_fs.default.writeFileSync(scriptPath, script, { mode: 384 });
  try {
    const { cmd, args } = osascriptArgs(scriptPath);
    return (0, import_node_child_process2.execFileSync)(cmd, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: KEYCHAIN_TIMEOUT_MS
    });
  } finally {
    try {
      import_node_fs.default.unlinkSync(scriptPath);
    } catch {
    }
  }
}
function macSave(account, secret) {
  runKeychainScript(
    keychainAddScript(),
    keychainScriptEnv(process.env, { account, service: SERVICE, secret })
  );
}
function macGet(account) {
  try {
    const out = runKeychainScript(
      keychainGetScript(),
      keychainScriptEnv(process.env, { account, service: SERVICE })
    );
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
function macRemove(account) {
  try {
    runKeychainScript(
      keychainRemoveScript(),
      keychainScriptEnv(process.env, { account, service: SERVICE })
    );
  } catch {
  }
}
function hasSecretTool() {
  try {
    (0, import_node_child_process2.execFileSync)("secret-tool", ["--version"], { stdio: "ignore", timeout: KEYCHAIN_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
function linuxSave(account, secret) {
  (0, import_node_child_process2.execFileSync)(
    "secret-tool",
    ["store", "--label", SERVICE, "service", SERVICE, "account", account],
    { input: secret, stdio: ["pipe", "ignore", "ignore"], timeout: KEYCHAIN_TIMEOUT_MS }
  );
}
function linuxGet(account) {
  try {
    return (0, import_node_child_process2.execFileSync)(
      "secret-tool",
      ["lookup", "service", SERVICE, "account", account],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: KEYCHAIN_TIMEOUT_MS }
    ).trim();
  } catch {
    return null;
  }
}
function linuxRemove(account) {
  try {
    (0, import_node_child_process2.execFileSync)(
      "secret-tool",
      ["clear", "service", SERVICE, "account", account],
      { stdio: "ignore", timeout: KEYCHAIN_TIMEOUT_MS }
    );
  } catch {
  }
}
function fileDir() {
  const base = process.env.XDG_CONFIG_HOME ?? import_node_path.default.join(import_node_os.default.homedir(), ".config");
  return import_node_path.default.join(base, "supremo", "checkpoint");
}
function filePath(account) {
  const safe = account.replace(/[^A-Za-z0-9_.-]/g, "_");
  return import_node_path.default.join(fileDir(), `${safe}.secret`);
}
function fileSave(account, secret) {
  import_node_fs.default.mkdirSync(fileDir(), { recursive: true, mode: 448 });
  import_node_fs.default.writeFileSync(filePath(account), secret, { mode: 384 });
}
function fileGet(account) {
  try {
    return import_node_fs.default.readFileSync(filePath(account), "utf8").trim();
  } catch {
    return null;
  }
}
function fileRemove(account) {
  try {
    import_node_fs.default.rmSync(filePath(account));
  } catch {
  }
}
function resolveKeychain(platform = process.platform) {
  if (platform === "darwin") {
    return {
      save: (p, s) => macSave(accountFor(p), s),
      get: (p) => macGet(accountFor(p)),
      remove: (p) => macRemove(accountFor(p))
    };
  }
  if (platform === "linux" && hasSecretTool()) {
    return {
      save: (p, s) => linuxSave(accountFor(p), s),
      get: (p) => linuxGet(accountFor(p)),
      remove: (p) => linuxRemove(accountFor(p))
    };
  }
  return {
    save: (p, s) => fileSave(accountFor(p), s),
    get: (p) => fileGet(accountFor(p)),
    remove: (p) => fileRemove(accountFor(p))
  };
}
var import_node_child_process2, import_node_crypto, import_node_fs, import_node_os, import_node_path, SERVICE, KEYCHAIN_TIMEOUT_MS, JXA_HELPERS;
var init_keychain = __esm({
  "src/keychain.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_node_crypto = __toESM(require("node:crypto"));
    import_node_fs = __toESM(require("node:fs"));
    import_node_os = __toESM(require("node:os"));
    import_node_path = __toESM(require("node:path"));
    SERVICE = "supremo-checkpoint-daemon";
    KEYCHAIN_TIMEOUT_MS = 2e4;
    JXA_HELPERS = `
function cfstr(s) { return $.NSString.alloc.initWithUTF8String(s) }
function env(name) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(name)
  return v ? v.js : null
}
function baseQuery(account, service) {
  var q = $.NSMutableDictionary.alloc.init
  q.setObjectForKey(cfstr('genp'), cfstr('class'))
  q.setObjectForKey(cfstr(account), cfstr('acct'))
  q.setObjectForKey(cfstr(service), cfstr('svce'))
  return q
}
`.trim();
  }
});

// src/checkpoint.ts
var checkpoint_exports = {};
__export(checkpoint_exports, {
  CHECKPOINT_DIR: () => CHECKPOINT_DIR,
  NOTIFY_FILE: () => NOTIFY_FILE,
  NothingToCheckpointError: () => NothingToCheckpointError,
  QUEUE_FILE: () => QUEUE_FILE,
  buildCheckpointRecord: () => buildCheckpointRecord,
  classifyCheckpointRisk: () => classifyCheckpointRisk,
  defaultCheckpointDeps: () => defaultCheckpointDeps,
  detectMigrations: () => detectMigrations,
  hasChanges: () => hasChanges,
  nextParentId: () => nextParentId,
  parseChangedPaths: () => parseChangedPaths,
  parseQueue: () => parseQueue,
  readProjectId: () => readProjectId,
  runCheckpoint: () => runCheckpoint,
  serializeQueue: () => serializeQueue
});
function hasChanges(porcelain) {
  return porcelain.trim().length > 0;
}
function parseChangedPaths(porcelain) {
  const out = [];
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim().length === 0)
      continue;
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1)
      rest = rest.slice(arrow + 4);
    rest = rest.trim().replace(/^"(.*)"$/, "$1");
    if (rest)
      out.push(rest);
  }
  return out;
}
function classifyCheckpointRisk(paths) {
  if (paths.some((p) => HIGH_RE.some((re) => re.test(p))))
    return "high";
  if (paths.length > 8 || paths.some((p) => MEDIUM_RE.some((re) => re.test(p)))) {
    return "medium";
  }
  return "low";
}
function detectMigrations(paths) {
  return paths.filter((p) => /supabase\/migrations\/.*\.sql$/.test(p));
}
function nextParentId(queue) {
  return queue.length > 0 ? queue[queue.length - 1].checkpointId : null;
}
function buildCheckpointRecord(input) {
  return {
    checkpointId: input.checkpointId,
    projectId: input.projectId,
    commitSha: input.commitSha,
    parentCheckpointId: input.parentCheckpointId,
    createdAt: input.createdAt,
    summary: input.summary,
    riskLevel: classifyCheckpointRisk(input.changedPaths),
    migrations: detectMigrations(input.changedPaths),
    changedPaths: [...input.changedPaths],
    pushStatus: "local",
    attempts: 0,
    ...input.restoredFromCheckpointId ? { restoredFromCheckpointId: input.restoredFromCheckpointId } : {},
    ...input.conversationId ? { conversationId: input.conversationId } : {},
    ...input.messageId ? { messageId: input.messageId } : {},
    ...input.originAgent ? { originAgent: input.originAgent } : {}
  };
}
function serializeQueue(queue) {
  return queue.map((r) => JSON.stringify(r)).join("\n") + (queue.length ? "\n" : "");
}
function parseQueue(jsonl) {
  const records = /* @__PURE__ */ new Map();
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t)
      continue;
    try {
      const record = JSON.parse(t);
      records.set(record.checkpointId, record);
    } catch {
    }
  }
  return [...records.values()];
}
function runCheckpoint(summary, projectId, deps, origin = {}) {
  const porcelain = deps.git(["status", "--porcelain"]);
  if (!hasChanges(porcelain))
    throw new NothingToCheckpointError();
  const changedPaths = parseChangedPaths(porcelain);
  deps.git(["add", "-A"]);
  deps.git(["commit", "-m", `checkpoint: ${summary}`]);
  const commitSha = deps.git(["rev-parse", "HEAD"]).trim();
  const queue = deps.readQueue();
  const { parentCheckpointIdOverride, ...restOrigin } = origin;
  const record = buildCheckpointRecord({
    checkpointId: deps.uuid(),
    projectId,
    commitSha,
    parentCheckpointId: parentCheckpointIdOverride !== void 0 ? parentCheckpointIdOverride : nextParentId(queue),
    createdAt: deps.now(),
    summary,
    changedPaths,
    ...restOrigin
  });
  deps.appendQueue(record);
  deps.notifyDaemon();
  return record;
}
function readProjectId(cwd) {
  try {
    const raw = JSON.parse(
      import_node_fs2.default.readFileSync(import_node_path2.default.join(cwd, ".supremo/project.json"), "utf8")
    );
    return raw.projectId ?? null;
  } catch {
    return null;
  }
}
function defaultCheckpointDeps(cwd) {
  const queuePath = import_node_path2.default.join(cwd, QUEUE_FILE);
  return {
    git: (args) => (0, import_node_child_process3.execFileSync)("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }),
    readQueue: () => {
      try {
        return parseQueue(import_node_fs2.default.readFileSync(queuePath, "utf8"));
      } catch {
        return [];
      }
    },
    appendQueue: (record) => {
      import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(queuePath), { recursive: true });
      import_node_fs2.default.appendFileSync(queuePath, JSON.stringify(record) + "\n");
    },
    notifyDaemon: () => {
      try {
        import_node_fs2.default.mkdirSync(import_node_path2.default.join(cwd, CHECKPOINT_DIR), { recursive: true });
        import_node_fs2.default.writeFileSync(import_node_path2.default.join(cwd, NOTIFY_FILE), (/* @__PURE__ */ new Date()).toISOString());
      } catch {
      }
    },
    now: () => (/* @__PURE__ */ new Date()).toISOString(),
    uuid: () => import_node_crypto2.default.randomUUID()
  };
}
var import_node_child_process3, import_node_crypto2, import_node_fs2, import_node_path2, HIGH_RE, MEDIUM_RE, NothingToCheckpointError, CHECKPOINT_DIR, QUEUE_FILE, NOTIFY_FILE;
var init_checkpoint = __esm({
  "src/checkpoint.ts"() {
    "use strict";
    import_node_child_process3 = require("node:child_process");
    import_node_crypto2 = __toESM(require("node:crypto"));
    import_node_fs2 = __toESM(require("node:fs"));
    import_node_path2 = __toESM(require("node:path"));
    HIGH_RE = [
      /supabase\/migrations\/.*\.sql$/,
      /(^|\/)app\/api\/.*route\.(ts|tsx|js|jsx)$/,
      /(^|\/)actions\//,
      /\.github\/workflows\//,
      /(^|\/)middleware\.(ts|js)$/,
      /\.(rls|policy)\.(sql|ts)$/,
      /(^|\/)(next\.config|tsconfig|package)\.(ts|js|json)$/,
      /(^|\/)vercel\.json$/
    ];
    MEDIUM_RE = [/(^|\/)(lib|hooks|stores|server|src\/lib)\//];
    NothingToCheckpointError = class extends Error {
      constructor() {
        super("Nada para checkpoint \u2014 nenhuma mudan\xE7a no worktree.");
        this.name = "NothingToCheckpointError";
      }
    };
    CHECKPOINT_DIR = ".supremo/checkpoints";
    QUEUE_FILE = `${CHECKPOINT_DIR}/queue.jsonl`;
    NOTIFY_FILE = `${CHECKPOINT_DIR}/notify`;
  }
});

// src/changeset.ts
function sha256Hex(buf) {
  return import_node_crypto3.default.createHash("sha256").update(buf).digest("hex");
}
function computeChangesetSha256(cs) {
  const files = [...cs.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const canonical = JSON.stringify({
    checkpointId: cs.checkpointId,
    parentCheckpointId: cs.parentCheckpointId,
    message: cs.message,
    files: files.map((f) => ({
      path: f.path,
      op: f.op,
      sha256: f.sha256 ?? null,
      mode: f.mode ?? "100644"
    }))
  });
  return sha256Hex(canonical);
}
function buildChangeset(record, reader) {
  const sha = record.commitSha;
  const meta = reader.meta(sha);
  const files = [];
  for (const ch of reader.changes(sha)) {
    const st = ch.status[0] ?? "";
    if (st === "D") {
      files.push({ path: ch.path, op: "delete" });
      continue;
    }
    if (st === "R" && ch.oldPath && ch.oldPath !== ch.path) {
      files.push({ path: ch.oldPath, op: "delete" });
    }
    const buf = reader.content(sha, ch.path);
    if (buf === null) {
      files.push({ path: ch.path, op: "delete" });
      continue;
    }
    files.push({
      path: ch.path,
      op: st === "A" || st === "R" || st === "C" ? "add" : "modify",
      contentBase64: buf.toString("base64"),
      sha256: sha256Hex(buf),
      mode: reader.executable(sha, ch.path) ? "100755" : "100644"
    });
  }
  return {
    checkpointId: record.checkpointId,
    commitSha: sha,
    parentCheckpointId: record.parentCheckpointId,
    message: meta.message,
    authorName: meta.authorName,
    authorEmail: meta.authorEmail,
    files
  };
}
function defaultCommitReader(cwd) {
  const text = (args) => (0, import_node_child_process4.execFileSync)("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const hasParent = (sha) => {
    try {
      (0, import_node_child_process4.execFileSync)("git", ["rev-parse", "--verify", `${sha}^`], {
        cwd,
        stdio: "ignore"
      });
      return true;
    } catch {
      return false;
    }
  };
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  return {
    changes: (sha) => {
      const base = hasParent(sha) ? `${sha}^` : EMPTY_TREE;
      const out = text(["diff", "--name-status", "-z", base, sha]);
      const parts = out.split("\0").filter((p) => p.length > 0);
      const changes = [];
      for (let i = 0; i < parts.length; ) {
        const status = parts[i++] ?? "";
        if (status.startsWith("R") || status.startsWith("C")) {
          const oldPath = parts[i++] ?? "";
          const path8 = parts[i++] ?? "";
          changes.push({ status, path: path8, oldPath });
        } else {
          const path8 = parts[i++] ?? "";
          changes.push({ status, path: path8 });
        }
      }
      return changes;
    },
    content: (sha, path8) => {
      try {
        return (0, import_node_child_process4.execFileSync)("git", ["show", `${sha}:${path8}`], {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024
        });
      } catch {
        return null;
      }
    },
    meta: (sha) => {
      const message = text(["show", "-s", "--format=%B", sha]).replace(/\n+$/, "\n").trimEnd();
      const authorName = text(["show", "-s", "--format=%an", sha]).trim();
      const authorEmail = text(["show", "-s", "--format=%ae", sha]).trim();
      return { message: message || "checkpoint", authorName, authorEmail };
    },
    executable: (sha, path8) => {
      try {
        const line = text(["ls-tree", sha, path8]);
        return line.slice(0, 6) === "100755";
      } catch {
        return false;
      }
    }
  };
}
var import_node_child_process4, import_node_crypto3;
var init_changeset = __esm({
  "src/changeset.ts"() {
    "use strict";
    import_node_child_process4 = require("node:child_process");
    import_node_crypto3 = __toESM(require("node:crypto"));
  }
});

// ../../src/lib/templates/managed-paths.ts
var PLATFORM_MANAGED_PATHS, MANAGED_PATHS;
var init_managed_paths = __esm({
  "../../src/lib/templates/managed-paths.ts"() {
    "use strict";
    PLATFORM_MANAGED_PATHS = [
      "tools/supremo-cli/package.json",
      "tools/supremo-cli/dist/bin.js",
      // Ferramentas e configuração
      "tsconfig.json",
      "next.config.ts",
      "eslint.config.mjs",
      "postcss.config.mjs",
      "vitest.config.ts",
      "vitest.setup.ts",
      "playwright.config.ts",
      "vercel.json",
      ".gitignore",
      ".nvmrc",
      // Infra da aplicação
      "lib/utils.ts",
      "components/preview-inspector.tsx",
      "proxy.ts",
      "lib/supabase/client.ts",
      "lib/supabase/server.ts",
      "app/auth/callback/route.ts",
      "app/auth/signout/route.ts",
      // Gates e segurança
      ".github/workflows/ci.yml",
      "e2e/smoke.spec.ts",
      "scripts/security-audit.js",
      // Local dev harness (base infra do Supremo)
      "scripts/verify.mjs",
      "scripts/setup-local.mjs",
      ".githooks/pre-commit",
      ".githooks/pre-push"
    ];
    MANAGED_PATHS = new Set(
      PLATFORM_MANAGED_PATHS
    );
  }
});

// src/restore.ts
function findLocalCommitForCheckpoint(queue, checkpointId) {
  const rec = queue.find((r) => r.checkpointId === checkpointId);
  return rec ? rec.commitSha : null;
}
function isEmptyPatch(patch) {
  return patch.trim().length === 0;
}
function restoreCommitMessage(targetSummary) {
  return `checkpoint: Restaurar "${targetSummary}"`;
}
function deepEqual(a, b) {
  if (a === b)
    return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length)
      return false;
    return keysA.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k])
    );
  }
  return false;
}
function isKnownNextTsconfigNoise(before, after) {
  let a;
  let b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null)
    return false;
  if (Array.isArray(a) || Array.isArray(b))
    return false;
  const { include: includeA, ...restA } = a;
  const { include: includeB, ...restB } = b;
  if (!Array.isArray(includeA) || !Array.isArray(includeB))
    return false;
  if (!includeA.every((x) => typeof x === "string") || !includeB.every((x) => typeof x === "string")) {
    return false;
  }
  if (!deepEqual(restA, restB))
    return false;
  const setA = new Set(includeA);
  const setB = new Set(includeB);
  const added = includeB.filter((x) => !setA.has(x));
  const removed = includeA.filter((x) => !setB.has(x));
  if (added.length === 0 && removed.length === 0)
    return false;
  return [...added, ...removed].every((entry) => NEXT_TYPES_GLOB_RE.test(entry));
}
function parseNameStatus(output) {
  const entries = [];
  for (const line of output.split("\n")) {
    const parts = line.split("	").filter((p) => p.length > 0);
    if (parts.length < 2)
      continue;
    const status = parts[0];
    if (!/^[AMDRCT]\d*$/.test(status))
      continue;
    const path8 = parts[parts.length - 1];
    entries.push({ status, path: path8 });
  }
  return entries;
}
function classifyMigrationDiff(entries) {
  const preservedPaths = entries.map((e) => e.path);
  const conflicts = entries.filter((e) => e.status !== "A" && e.status !== "D").map((e) => e.path);
  return { preservedPaths, conflicts };
}
function isRestoreSafeguardNoise(porcelain, deps) {
  const changedPaths = parseChangedPaths(porcelain);
  if (changedPaths.length !== 1 || changedPaths[0] !== "tsconfig.json")
    return false;
  let before;
  try {
    before = deps.git(["show", "HEAD:tsconfig.json"]);
  } catch {
    return false;
  }
  const after = deps.readWorktreeFile("tsconfig.json");
  if (after === null)
    return false;
  return isKnownNextTsconfigNoise(before, after);
}
function applyRestore(targetCheckpointId, targetSummary, projectId, deps) {
  let queue = deps.readQueue();
  const targetSha = findLocalCommitForCheckpoint(queue, targetCheckpointId);
  if (!targetSha)
    throw new RestoreTargetNotFoundLocallyError();
  const porcelain = deps.git(["status", "--porcelain"]);
  if (hasChanges(porcelain) && !isRestoreSafeguardNoise(porcelain, deps)) {
    const changedPaths = parseChangedPaths(porcelain);
    deps.git(["add", "-A"]);
    deps.git(["commit", "--no-verify", "-m", "checkpoint: salvaguarda autom\xE1tica antes do restore"]);
    const autoSha = deps.git(["rev-parse", "HEAD"]).trim();
    const autoRecord = buildCheckpointRecord({
      checkpointId: deps.uuid(),
      projectId,
      commitSha: autoSha,
      parentCheckpointId: nextParentId(queue),
      createdAt: deps.now(),
      summary: "Salvaguarda autom\xE1tica antes do restore",
      changedPaths
    });
    deps.appendQueue(autoRecord);
    queue = [...queue, autoRecord];
  }
  const currentHead = deps.git(["rev-parse", "HEAD"]).trim();
  let migrationStatusOutput = "";
  try {
    migrationStatusOutput = deps.git([
      "diff",
      "--name-status",
      currentHead,
      targetSha,
      "--",
      MIGRATIONS_PATHSPEC
    ]);
  } catch {
    migrationStatusOutput = "";
  }
  const { preservedPaths: preservedMigrations, conflicts: migrationConflicts } = classifyMigrationDiff(
    parseNameStatus(migrationStatusOutput)
  );
  const patch = deps.git([
    "diff",
    "--binary",
    currentHead,
    targetSha,
    "--",
    ".",
    ...RESTORE_PRESERVED_PATHS.map((managedPath) => `:(exclude)${managedPath}`)
  ]);
  if (isEmptyPatch(patch)) {
    return { applied: false, record: null, preservedMigrations, migrationConflicts };
  }
  deps.applyPatch(patch);
  deps.git(["commit", "--no-verify", "-m", restoreCommitMessage(targetSummary)]);
  const newSha = deps.git(["rev-parse", "HEAD"]).trim();
  const record = buildCheckpointRecord({
    checkpointId: deps.uuid(),
    projectId,
    commitSha: newSha,
    parentCheckpointId: nextParentId(queue),
    createdAt: deps.now(),
    summary: `Restaurar "${targetSummary}"`,
    changedPaths: parseChangedPathsFromDiff(patch),
    restoredFromCheckpointId: targetCheckpointId
  });
  deps.appendQueue(record);
  deps.notifyDaemon();
  return { applied: true, record, preservedMigrations, migrationConflicts };
}
function parseChangedPathsFromDiff(patch) {
  const out = /* @__PURE__ */ new Set();
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      out.add(m[2]);
    }
  }
  return [...out];
}
function defaultRestoreDeps(base, cwd) {
  return {
    ...base,
    applyPatch: (patch) => {
      (0, import_node_child_process5.execFileSync)("git", ["apply", "--index", "--whitespace=nowarn"], {
        cwd,
        input: patch,
        stdio: ["pipe", "ignore", "pipe"]
      });
    },
    readWorktreeFile: (relPath) => {
      try {
        return import_node_fs3.default.readFileSync(import_node_path3.default.join(cwd, relPath), "utf8");
      } catch {
        return null;
      }
    }
  };
}
var import_node_child_process5, import_node_fs3, import_node_path3, RestoreTargetNotFoundLocallyError, NEXT_TYPES_GLOB_RE, MIGRATIONS_PATHSPEC, RESTORE_PRESERVED_PATHS;
var init_restore = __esm({
  "src/restore.ts"() {
    "use strict";
    import_node_child_process5 = require("node:child_process");
    import_node_fs3 = __toESM(require("node:fs"));
    import_node_path3 = __toESM(require("node:path"));
    init_managed_paths();
    init_checkpoint();
    RestoreTargetNotFoundLocallyError = class extends Error {
      constructor() {
        super(
          "Checkpoint alvo n\xE3o encontrado no hist\xF3rico local desta m\xE1quina \u2014 restore hoje s\xF3 funciona na MESMA m\xE1quina que criou o checkpoint."
        );
        this.name = "RestoreTargetNotFoundLocallyError";
      }
    };
    NEXT_TYPES_GLOB_RE = /^\.?\/?\.next\/(dev\/)?types\/\*\*\/\*\.ts$/;
    MIGRATIONS_PATHSPEC = "supabase/migrations";
    RESTORE_PRESERVED_PATHS = [
      MIGRATIONS_PATHSPEC,
      ...PLATFORM_MANAGED_PATHS
    ];
  }
});

// src/daemon.ts
var daemon_exports = {};
__export(daemon_exports, {
  AuthError: () => AuthError,
  ConflictError: () => ConflictError,
  DAEMON_LOG_FILE: () => DAEMON_LOG_FILE,
  DAEMON_PID_FILE: () => DAEMON_PID_FILE,
  NetworkError: () => NetworkError,
  SYNC_STATUS_TIMEOUT_MS: () => SYNC_STATUS_TIMEOUT_MS,
  backoffDelayMs: () => backoffDelayMs,
  classifyPidSignalError: () => classifyPidSignalError,
  daemonStatus: () => daemonStatus,
  defaultDaemonHttp: () => defaultDaemonHttp,
  drainOnce: () => drainOnce,
  ensureDaemon: () => ensureDaemon,
  processCheckpoint: () => processCheckpoint,
  processRestores: () => processRestores,
  readProjectConfig: () => readProjectConfig,
  runDaemonLoop: () => runDaemonLoop,
  selectNextPending: () => selectNextPending,
  stopDaemon: () => stopDaemon,
  upsertQueue: () => upsertQueue,
  withStatus: () => withStatus
});
function selectNextPending(queue) {
  for (const r of queue)
    if (RETRIABLE.has(r.pushStatus))
      return r;
  return null;
}
function backoffDelayMs(attempts, baseMs = 2e3, maxMs = 6e4) {
  const n = Math.max(0, attempts);
  return Math.min(maxMs, baseMs * 2 ** n);
}
function withStatus(record, status, patch = {}) {
  return { ...record, pushStatus: status, ...patch };
}
function upsertQueue(queue, record) {
  return queue.map((r) => r.checkpointId === record.checkpointId ? record : r);
}
async function processCheckpoint(record, ctx) {
  const secret = ctx.getSecret();
  if (!secret) {
    return {
      record: withStatus(record, "push_failed"),
      result: "failed",
      reason: "device_not_provisioned"
    };
  }
  const changeset = buildChangeset(record, ctx.reader);
  if (changeset.files.length === 0) {
    return {
      record: withStatus(record, "push_failed"),
      result: "failed",
      reason: "empty_changeset"
    };
  }
  const changesetSha256 = computeChangesetSha256(changeset);
  try {
    const { prNumber } = await ctx.http.publish({
      deviceSecret: secret,
      projectId: ctx.projectId,
      changeset,
      changesetSha256,
      riskLevel: record.riskLevel,
      summary: record.summary,
      migrations: record.migrations,
      ...record.restoredFromCheckpointId ? { restoredFromCheckpointId: record.restoredFromCheckpointId } : {},
      ...record.conversationId ? { conversationId: record.conversationId } : {},
      ...record.messageId ? { messageId: record.messageId } : {},
      ...record.originAgent ? { originAgent: record.originAgent } : {}
    });
    return {
      record: withStatus(record, "published", { prNumber }),
      result: "done"
    };
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        record: withStatus(record, "push_failed"),
        result: "failed",
        reason: "unauthorized"
      };
    }
    const reason = err instanceof ConflictError ? "conflict" : "network";
    return {
      record: withStatus(record, "upload_pending", { attempts: record.attempts + 1 }),
      result: "deferred",
      reason
    };
  }
}
function defaultDaemonHttp(apiBaseUrl) {
  const base = apiBaseUrl.replace(/\/$/, "");
  const postJson = async (route, body, timeoutMs) => {
    let res;
    const controller = timeoutMs != null ? new AbortController() : void 0;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : void 0;
    try {
      res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // codeql[js/file-access-to-http] mesmo fluxo intencional (ver nota acima)
        body: JSON.stringify(body),
        ...controller ? { signal: controller.signal } : {}
      });
    } catch {
      throw new NetworkError("offline");
    } finally {
      if (timer)
        clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403)
      throw new AuthError(`${res.status}`);
    if (res.status === 409)
      throw new ConflictError("conflict");
    if (!res.ok)
      throw new NetworkError(`${res.status}`);
    return res.json().catch(() => ({}));
  };
  return {
    publish: async (input) => {
      const data = await postJson("/api/checkpoint/publish", input);
      return { prNumber: data.prNumber ?? 0 };
    },
    pollRestores: async (input) => {
      const data = await postJson("/api/checkpoint/restore-poll", input);
      return data.requests ?? [];
    },
    reportRestoreApplied: async (input) => {
      await postJson("/api/checkpoint/restore-report", {
        deviceSecret: input.deviceSecret,
        restoreRequestId: input.restoreRequestId,
        status: "applied",
        resultCheckpointId: input.resultCheckpointId
      });
    },
    reportRestoreFailed: async (input) => {
      await postJson("/api/checkpoint/restore-report", {
        deviceSecret: input.deviceSecret,
        restoreRequestId: input.restoreRequestId,
        status: "failed",
        error: input.error
      });
    },
    syncStatus: async (input) => {
      const data = await postJson(
        "/api/checkpoint/sync-status",
        input,
        SYNC_STATUS_TIMEOUT_MS
      );
      return { latest: data.latest ?? null };
    }
  };
}
function readProjectConfig(cwd) {
  try {
    const raw = JSON.parse(
      import_node_fs4.default.readFileSync(import_node_path4.default.join(cwd, ".supremo/project.json"), "utf8")
    );
    if (!raw.projectId || !raw.supremoUrl)
      return null;
    return { projectId: raw.projectId, apiBaseUrl: raw.supremoUrl };
  } catch {
    return null;
  }
}
function classifyPidSignalError(code) {
  return code === "ESRCH" ? "dead" : "unknown";
}
function pidState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return classifyPidSignalError(err?.code);
  }
}
function pidAlive(pid) {
  return pidState(pid) !== "dead";
}
function readPid(cwd) {
  try {
    const pid = Number(import_node_fs4.default.readFileSync(import_node_path4.default.join(cwd, DAEMON_PID_FILE), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function ensureDaemon(cwd) {
  const existing = readPid(cwd);
  if (existing && pidAlive(existing))
    return "reuse";
  import_node_fs4.default.mkdirSync(import_node_path4.default.join(cwd, CHECKPOINT_DIR), { recursive: true });
  const logPath = import_node_path4.default.join(cwd, DAEMON_LOG_FILE);
  const out = import_node_fs4.default.openSync(logPath, "a");
  const localBin = import_node_path4.default.join(cwd, "node_modules/.bin/supremo");
  const binPath = import_node_fs4.default.existsSync(localBin) ? localBin : process.argv[1] ?? "";
  const child = (0, import_node_child_process6.spawn)(process.execPath, [binPath, "daemon"], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  if (child.pid) {
    import_node_fs4.default.writeFileSync(import_node_path4.default.join(cwd, DAEMON_PID_FILE), String(child.pid));
  }
  return "start";
}
function daemonStatus(cwd) {
  const pid = readPid(cwd);
  const running = pid != null && pidAlive(pid);
  let pendingCheckpoints = 0;
  try {
    const queue = parseQueue(import_node_fs4.default.readFileSync(import_node_path4.default.join(cwd, QUEUE_FILE), "utf8"));
    pendingCheckpoints = queue.filter((r) => RETRIABLE.has(r.pushStatus)).length;
  } catch {
  }
  return { running, healthy: running, pid, pendingCheckpoints };
}
function stopDaemon(cwd) {
  const pid = readPid(cwd);
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {
    }
  }
  try {
    import_node_fs4.default.rmSync(import_node_path4.default.join(cwd, DAEMON_PID_FILE));
  } catch {
  }
  return true;
}
function minPendingAttempts(queue) {
  let min = null;
  for (const r of queue) {
    if (RETRIABLE.has(r.pushStatus)) {
      min = min === null ? r.attempts : Math.min(min, r.attempts);
    }
  }
  return min;
}
async function processRestores(config, overrides = {}) {
  const secret = config.getSecret();
  if (!secret)
    return 0;
  const http = overrides.http ?? defaultDaemonHttp(config.apiBaseUrl);
  let pending;
  try {
    pending = await http.pollRestores({ deviceSecret: secret, projectId: config.projectId });
  } catch {
    return 0;
  }
  if (pending.length === 0)
    return 0;
  const deps = overrides.deps ?? defaultRestoreDeps(defaultCheckpointDeps(config.cwd), config.cwd);
  for (const req of pending) {
    try {
      const outcome = applyRestore(
        req.targetCheckpointId,
        req.targetSummary,
        config.projectId,
        deps
      );
      if (outcome.migrationConflicts.length > 0) {
        console.error(
          `\u26A0 restore: ${outcome.migrationConflicts.length} migration(s) com conte\xFAdo divergente entre o estado atual e o alvo do restore \u2014 preservada(s) como est\xE1(\xE3o) (nunca reescrita(s)): ${outcome.migrationConflicts.join(", ")}`
        );
      }
      await http.reportRestoreApplied({
        deviceSecret: secret,
        restoreRequestId: req.restoreRequestId,
        resultCheckpointId: outcome.applied ? outcome.record?.checkpointId ?? null : null
      });
    } catch (err) {
      const message = err instanceof RestoreTargetNotFoundLocallyError ? err.message : err instanceof Error ? err.message : "falha desconhecida ao aplicar restore";
      await http.reportRestoreFailed({ deviceSecret: secret, restoreRequestId: req.restoreRequestId, error: message }).catch(() => {
      });
    }
  }
  return pending.length;
}
async function drainOnce(config) {
  await processRestores(config);
  const queuePath = import_node_path4.default.join(config.cwd, QUEUE_FILE);
  let queue;
  try {
    queue = parseQueue(import_node_fs4.default.readFileSync(queuePath, "utf8"));
  } catch {
    return 0;
  }
  const ctx = {
    projectId: config.projectId,
    getSecret: config.getSecret,
    http: defaultDaemonHttp(config.apiBaseUrl),
    reader: defaultCommitReader(config.cwd)
  };
  let processed = 0;
  for (; ; ) {
    const next = selectNextPending(queue);
    if (!next)
      break;
    const outcome = await processCheckpoint(next, ctx);
    queue = upsertQueue(queue, outcome.record);
    import_node_fs4.default.appendFileSync(queuePath, serializeQueue([outcome.record]));
    processed++;
    if (outcome.result !== "done")
      break;
  }
  return processed;
}
async function runDaemonLoop(cwd, opts = {}) {
  const config = readProjectConfig(cwd);
  if (!config) {
    process.stderr.write("[daemon] .supremo/project.json ausente/incompleto.\n");
    return;
  }
  const keychain = resolveKeychain();
  const daemonConfig = {
    projectId: config.projectId,
    apiBaseUrl: config.apiBaseUrl,
    cwd,
    getSecret: () => keychain.get(config.projectId)
  };
  const idleMs = opts.idleMs ?? 3e3;
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  while (!stopped) {
    let queue = [];
    try {
      queue = parseQueue(import_node_fs4.default.readFileSync(import_node_path4.default.join(cwd, QUEUE_FILE), "utf8"));
    } catch {
    }
    await drainOnce(daemonConfig);
    try {
      import_node_fs4.default.rmSync(import_node_path4.default.join(cwd, NOTIFY_FILE));
    } catch {
    }
    const attempts = minPendingAttempts(queue);
    await sleep(attempts != null ? backoffDelayMs(attempts) : idleMs);
  }
}
var import_node_child_process6, import_node_fs4, import_node_path4, RETRIABLE, NetworkError, AuthError, ConflictError, SYNC_STATUS_TIMEOUT_MS, DAEMON_PID_FILE, DAEMON_LOG_FILE, sleep;
var init_daemon = __esm({
  "src/daemon.ts"() {
    "use strict";
    import_node_child_process6 = require("node:child_process");
    import_node_fs4 = __toESM(require("node:fs"));
    import_node_path4 = __toESM(require("node:path"));
    init_checkpoint();
    init_changeset();
    init_keychain();
    init_restore();
    RETRIABLE = /* @__PURE__ */ new Set([
      "local",
      "upload_pending",
      "publishing"
    ]);
    NetworkError = class extends Error {
    };
    AuthError = class extends Error {
    };
    ConflictError = class extends Error {
    };
    SYNC_STATUS_TIMEOUT_MS = 2e3;
    DAEMON_PID_FILE = `${CHECKPOINT_DIR}/daemon.pid`;
    DAEMON_LOG_FILE = `${CHECKPOINT_DIR}/daemon.log`;
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// src/bootstrap.ts
var bootstrap_exports = {};
__export(bootstrap_exports, {
  RECOMMENDED_NODE_MAJORS: () => RECOMMENDED_NODE_MAJORS,
  buildEnvFile: () => buildEnvFile,
  checkNodeVersion: () => checkNodeVersion,
  cleanRemoteUrl: () => cleanRemoteUrl,
  daemonCliOutputLooksValid: () => daemonCliOutputLooksValid,
  gitCloneArgs: () => gitCloneArgs,
  migrationDryRunSynced: () => migrationDryRunSynced,
  patchConfigMajorVersion: () => patchConfigMajorVersion,
  previewStatusHealthy: () => previewStatusHealthy,
  projectListHasRef: () => projectListHasRef,
  resolveSupabaseBin: () => resolveSupabaseBin,
  runBootstrap: () => runBootstrap,
  supabaseLinkArgs: () => supabaseLinkArgs,
  supabaseLinkEnv: () => supabaseLinkEnv,
  targetDir: () => targetDir,
  validateLocalReadiness: () => validateLocalReadiness
});
function buildEnvFile(env) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
function targetDir(repoFullName, baseDir) {
  const name = repoFullName.split("/").pop() || "projeto";
  return import_node_path5.default.join(baseDir ?? process.cwd(), name);
}
function cleanRemoteUrl(repoFullName) {
  return `https://github.com/${repoFullName}.git`;
}
function gitCloneArgs(repoFullName, branch, dest) {
  const helper = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$SUPREMO_GIT_TOKEN"; }; f`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${helper}`,
    "clone",
    "--branch",
    branch,
    cleanRemoteUrl(repoFullName),
    dest
  ];
}
function supabaseLinkArgs(projectRef) {
  return ["link", "--project-ref", projectRef];
}
function supabaseLinkEnv(base, dbPassword) {
  return dbPassword ? { ...base, SUPABASE_DB_PASSWORD: dbPassword } : { ...base };
}
function projectListHasRef(projectsListOutput, projectRef) {
  return projectsListOutput.includes(projectRef);
}
function patchConfigMajorVersion(configToml, major) {
  return configToml.replace(
    /^(\s*major_version\s*=\s*)\d+/m,
    `$1${major}`
  );
}
function migrationDryRunSynced(dryRunOutput) {
  if (/up to date|no schema changes|nothing to push/i.test(dryRunOutput)) {
    return true;
  }
  return !/\b\d{14}_/.test(dryRunOutput);
}
async function startDeviceFlow(baseUrl, projectId) {
  const res = await fetch(`${baseUrl}/api/bootstrap/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `N\xE3o iniciou o bootstrap (${res.status}).`);
  }
  return await res.json();
}
async function pollForConfig(baseUrl, deviceCode, intervalSec, expiresAt) {
  const deadline = Date.parse(expiresAt);
  while (Date.now() < deadline) {
    await sleep2(intervalSec * 1e3);
    const res = await fetch(`${baseUrl}/api/bootstrap/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode })
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === "ready" && data.config)
      return data.config;
    if (data.status === "pending")
      continue;
    if (data.status === "expired")
      throw new Error("Autoriza\xE7\xE3o expirou.");
    if (data.status === "denied")
      throw new Error("Autoriza\xE7\xE3o negada.");
    if (data.status === "error")
      throw new Error(data.error ?? "Falha no bootstrap.");
    throw new Error("Autoriza\xE7\xE3o inv\xE1lida. Rode o comando de novo.");
  }
  throw new Error("Tempo de autoriza\xE7\xE3o esgotado.");
}
function daemonCliOutputLooksValid(output) {
  if (output === null)
    return false;
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === "object" && parsed !== null && typeof parsed.running === "boolean";
  } catch {
    return false;
  }
}
function previewStatusHealthy(output) {
  if (output === null)
    return false;
  try {
    const parsed = JSON.parse(output);
    return parsed.running === true && parsed.healthy === true;
  } catch {
    return false;
  }
}
function validateLocalReadiness(input) {
  const issues = [];
  if (!input.projectJsonOk)
    issues.push(".supremo/project.json ausente/incompleto");
  if (input.hasDaemonIdentity) {
    if (!input.daemonRunning)
      issues.push("checkpoint daemon n\xE3o subiu");
    if (input.npmScriptsCompatible === false) {
      issues.push(
        'os scripts npm gerados (checkpoint/daemon) n\xE3o batem com a CLI resolvida por npx \u2014 pode estar desatualizada (aguarde a publica\xE7\xE3o mais recente e rode "npm run daemon:ensure" de novo)'
      );
    }
  }
  if (!input.previewHealthy)
    issues.push("preview n\xE3o subiu saud\xE1vel");
  return { ok: issues.length === 0, issues };
}
function checkNpmScriptsCompatible(dest) {
  return daemonCliOutputLooksValid(
    tryExecOutIn(process.execPath, [import_node_path5.default.join(dest, "node_modules/supremo-cli/dist/bin.js"), "daemon", "--status"], dest)
  );
}
function checkNodeVersion(nodeVersion) {
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  if (RECOMMENDED_NODE_MAJORS.includes(major)) {
    return { status: "ok", major };
  }
  return {
    status: "warn",
    major,
    message: `Node ${nodeVersion} n\xE3o \xE9 uma vers\xE3o LTS testada pelo Supremo (recomendado: Node 22 LTS). Isto N\xC3O deveria travar a instala\xE7\xE3o, mas algumas depend\xEAncias podem avisar incompatibilidade (EBADENGINE) \u2014 se algo estranho acontecer, troque para Node 22 LTS e rode o bootstrap de novo.`
  };
}
function checkPreviewHealthy(dest) {
  return previewStatusHealthy(tryExecOutIn("node", ["scripts/preview.mjs", "status"], dest));
}
async function linkSupabaseRemote(dest, supabase) {
  const { projectRef, dbPassword, majorVersion } = supabase;
  const { bin: sb, local } = resolveSupabaseBin(dest);
  const manual = `cd ${dest} && npx supabase link --project-ref ${projectRef}`;
  const version = tryExecOut(sb, ["--version"]);
  if (version === null) {
    console.log(
      `
\u2022 Supabase CLI n\xE3o dispon\xEDvel \u2014 pulei o link do banco online.
  A CLI \xE9 uma devDependency pinada; garanta o "npm ci" e rode:
    ${manual}
`
    );
    return false;
  }
  ok(`Supabase CLI dispon\xEDvel (${local ? "local pinada" : "global"} v${version.trim()})`);
  const supabaseOk = await ensureAuthorized({
    name: "Supabase",
    prompt: "Supabase precisa ser autorizado nesta m\xE1quina. Pressione ENTER para continuar\u2026",
    isAuthorized: () => tryExecOut(sb, ["projects", "list"]) !== null,
    authorize: () => {
      try {
        run(sb, ["login"], dest);
      } catch {
      }
    }
  });
  if (!supabaseOk) {
    console.log(`\u2022 Login do Supabase n\xE3o conclu\xEDdo \u2014 pulei o link.
    ${manual}
`);
    return false;
  }
  let projects = tryExecOut(sb, ["projects", "list"]) ?? "";
  if (!projectListHasRef(projects, projectRef)) {
    await defaultAuthIO.waitForEnter(
      "A conta Supabase logada n\xE3o \xE9 a dona deste projeto. Pressione ENTER para entrar na conta certa\u2026"
    );
    tryExec(sb, ["logout"]);
    try {
      run(sb, ["login"], dest);
    } catch {
    }
    projects = tryExecOut(sb, ["projects", "list"]) ?? "";
    if (!projectListHasRef(projects, projectRef)) {
      console.log(
        `
\u2022 A conta logada ainda n\xE3o \xE9 a dona do projeto ${projectRef}.
  Entre com a MESMA conta Supabase que voc\xEA conectou ao Supremo:
    npx supabase login && ( ${manual} )
`
      );
      return false;
    }
  }
  ok("Conta correta");
  if (majorVersion) {
    try {
      const cfgPath = import_node_path5.default.join(dest, "supabase", "config.toml");
      const cfg = import_node_fs5.default.readFileSync(cfgPath, "utf8");
      const patched = patchConfigMajorVersion(cfg, majorVersion);
      if (patched !== cfg)
        import_node_fs5.default.writeFileSync(cfgPath, patched);
      ok("PostgreSQL/config alinhados");
    } catch {
    }
  }
  try {
    (0, import_node_child_process7.execFileSync)(sb, supabaseLinkArgs(projectRef), {
      cwd: dest,
      env: supabaseLinkEnv(process.env, dbPassword),
      stdio: ["ignore", "ignore", "inherit"]
    });
  } catch {
    console.log(`\u2022 N\xE3o consegui linkar automaticamente. Rode:
    ${manual}
`);
    return false;
  }
  const linkedRef = readLinkedRef(dest);
  if (linkedRef !== projectRef) {
    console.log(
      `
\u2022 Diverg\xEAncia no link: esperado ${projectRef}, mas supabase/.temp/project-ref = ${linkedRef ?? "(vazio)"}. Parei antes de qualquer opera\xE7\xE3o no banco.
`
    );
    return false;
  }
  ok(`Projeto linkado: ${projectRef}`);
  const dry = tryExecOut(sb, ["db", "push", "--dry-run"]);
  if (dry !== null && migrationDryRunSynced(dry)) {
    ok("Migration history sincronizado");
  }
  return true;
}
function resolveSupabaseBin(dest) {
  const localBin = import_node_path5.default.join(dest, "node_modules", ".bin", "supabase");
  return import_node_fs5.default.existsSync(localBin) ? { bin: localBin, local: true } : { bin: "supabase", local: false };
}
function readLinkedRef(dest) {
  try {
    return import_node_fs5.default.readFileSync(import_node_path5.default.join(dest, "supabase", ".temp", "project-ref"), "utf8").trim();
  } catch {
    return null;
  }
}
async function runBootstrap(opts) {
  const baseUrl = opts.url.replace(/\/$/, "");
  console.log("\nSupremo Bootstrap\n");
  const nodeCheck = checkNodeVersion(process.version);
  if (nodeCheck.status === "warn") {
    console.log(`\u26A0 ${nodeCheck.message}
`);
  }
  const held = { config: null };
  const supremoOk = await ensureAuthorized({
    name: "Supremo",
    prompt: "Supremo precisa autorizar esta m\xE1quina. Pressione ENTER para continuar\u2026",
    isAuthorized: () => held.config !== null,
    authorize: async () => {
      const flow = await startDeviceFlow(baseUrl, opts.projectId);
      const opened = await openBrowser(flow.verificationUriComplete);
      if (!opened) {
        console.log("\n  N\xE3o consegui abrir o navegador. Abra manualmente:");
        console.log(`  ${flow.verificationUriComplete}`);
        console.log(`  C\xF3digo: ${flow.userCode}`);
      }
      console.log("Aguardando autoriza\xE7\xE3o\u2026");
      held.config = await pollForConfig(
        baseUrl,
        flow.deviceCode,
        flow.intervalSec,
        flow.expiresAt
      );
    }
  });
  const config = held.config;
  if (!supremoOk || !config) {
    throw new Error("Supremo n\xE3o autorizado \u2014 rode o bootstrap de novo.");
  }
  console.log(`  Projeto: ${config.project.name}`);
  const dest = targetDir(config.repo.fullName, opts.dir);
  if (import_node_fs5.default.existsSync(dest)) {
    throw new Error(`J\xE1 existe ${dest} \u2014 remova ou use --dir para outro caminho.`);
  }
  import_node_fs5.default.mkdirSync(import_node_path5.default.dirname(dest), { recursive: true });
  run("git", gitCloneArgs(config.repo.fullName, config.repo.branch, dest), void 0, {
    ...process.env,
    SUPREMO_GIT_TOKEN: config.gitToken
  });
  ok("Repository clonado");
  import_node_fs5.default.writeFileSync(import_node_path5.default.join(dest, ".env.local"), buildEnvFile(config.env), {
    mode: 384
  });
  ok("Environment p\xFAblico configurado");
  import_node_fs5.default.mkdirSync(import_node_path5.default.join(dest, ".supremo"), { recursive: true });
  import_node_fs5.default.writeFileSync(import_node_path5.default.join(dest, ".supremo/database.json"), JSON.stringify(config.database ?? {
    environment: "unknown",
    projectRef: config.supabase?.projectRef ?? null,
    automaticMigrations: false
  }, null, 2) + "\n");
  run("npm", ["ci"], dest);
  ok("Depend\xEAncias instaladas");
  const linked = config.supabase?.projectRef ? await linkSupabaseRemote(dest, config.supabase) : false;
  try {
    run("npm", ["run", "setup:local"], dest);
    ok("Verify passou");
  } catch {
    console.log('\u2022 setup:local pulado (rode "npm run setup:local" manualmente)');
  }
  if (linked)
    ok("Claude/Codex prontos para trabalhar no Supabase online");
  let daemonRunning = false;
  let npmScriptsCompatible = null;
  if (config.daemon) {
    try {
      const keychainModule = await Promise.resolve().then(() => (init_keychain(), keychain_exports));
      const keychain = keychainModule.resolveKeychain();
      keychain.save(config.project.id, config.daemon.deviceSecret);
      if (keychain.get(config.project.id) !== config.daemon.deviceSecret) {
        throw new Error("Secret n\xE3o confirmado no keychain ap\xF3s salvar.");
      }
      ok("M\xE1quina autorizada (checkpoint daemon) \u2014 identidade no keychain");
      const { ensureDaemon: ensureDaemon2, daemonStatus: daemonStatus2 } = await Promise.resolve().then(() => (init_daemon(), daemon_exports));
      ensureDaemon2(dest);
      daemonRunning = daemonStatus2(dest).running;
      if (daemonRunning) {
        ok("Checkpoint daemon no ar \u2014 push/PR em background (npm run daemon:status)");
      }
      npmScriptsCompatible = checkNpmScriptsCompatible(dest);
      if (npmScriptsCompatible) {
        ok("Scripts de checkpoint/daemon compat\xEDveis com a CLI instalada");
      }
    } catch {
      console.log(
        "\u2022 N\xE3o consegui preparar o checkpoint daemon automaticamente.\n  Rode depois: npm run daemon:ensure\n"
      );
    }
  }
  let previewHealthy = false;
  try {
    run("npm", ["run", "preview:ensure"], dest);
    previewHealthy = checkPreviewHealthy(dest);
    if (previewHealthy)
      ok("Preview no ar (npm run preview:status)");
  } catch {
    console.log(
      "\u2022 N\xE3o consegui subir o preview automaticamente.\n  Rode depois: npm run preview:ensure\n"
    );
  }
  const readiness = validateLocalReadiness({
    projectJsonOk: import_node_fs5.default.existsSync(import_node_path5.default.join(dest, ".supremo", "project.json")),
    hasDaemonIdentity: Boolean(config.daemon),
    daemonRunning,
    npmScriptsCompatible,
    previewHealthy
  });
  if (readiness.ok) {
    const url = "http://localhost:3000";
    console.log(
      `
Projeto pronto para Codex/Claude:

  ${dest}
  Preview: ${url}
`
    );
  } else {
    console.log(`
\u26A0 Projeto criado, mas o workflow local n\xE3o est\xE1 100% operacional:
`);
    for (const issue of readiness.issues)
      console.log(`  \u2022 ${issue}`);
    console.log(
      `
  O c\xF3digo funciona normalmente; resolva o(s) ponto(s) acima antes de
  contar com checkpoint/publica\xE7\xE3o/preview autom\xE1ticos.

  Pasta: ${dest}
`
    );
  }
}
var import_node_child_process7, import_node_fs5, import_node_path5, sleep2, run, ok, tryExec, tryExecOut, tryExecOutIn, RECOMMENDED_NODE_MAJORS;
var init_bootstrap = __esm({
  "src/bootstrap.ts"() {
    "use strict";
    import_node_child_process7 = require("node:child_process");
    import_node_fs5 = __toESM(require("node:fs"));
    import_node_path5 = __toESM(require("node:path"));
    init_auth();
    sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    run = (cmd, args, cwd, env) => (0, import_node_child_process7.execFileSync)(cmd, args, { cwd, env, stdio: "inherit" });
    ok = (label) => console.log(`\u2713 ${label}`);
    tryExec = (cmd, args) => {
      try {
        (0, import_node_child_process7.execFileSync)(cmd, args, { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    tryExecOut = (cmd, args) => {
      try {
        return (0, import_node_child_process7.execFileSync)(cmd, args, {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8"
        });
      } catch {
        return null;
      }
    };
    tryExecOutIn = (cmd, args, cwd) => {
      try {
        return (0, import_node_child_process7.execFileSync)(cmd, args, {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8"
        });
      } catch {
        return null;
      }
    };
    RECOMMENDED_NODE_MAJORS = [20, 22, 24];
  }
});

// src/sync.ts
var sync_exports = {};
__export(sync_exports, {
  SYNC_STATE_FILE: () => SYNC_STATE_FILE,
  defaultSyncDeps: () => defaultSyncDeps,
  planSync: () => planSync,
  readSyncedRemoteState: () => readSyncedRemoteState,
  resolveParentCheckpointId: () => resolveParentCheckpointId,
  runSync: () => runSync
});
function resolveParentCheckpointId(queue, syncedRemote) {
  const localLast = queue.length > 0 ? queue[queue.length - 1] : null;
  if (!syncedRemote)
    return localLast?.checkpointId ?? null;
  if (!localLast)
    return syncedRemote.checkpointId;
  return new Date(syncedRemote.createdAt).getTime() > new Date(localLast.createdAt).getTime() ? syncedRemote.checkpointId : localLast.checkpointId;
}
function syncTarget(remote) {
  if (remote.pushStatus === "integrated" || remote.integrationStatus === "merged") {
    return { branch: "main", pinnedSha: null };
  }
  if (remote.pushStatus === "published" && remote.integrationBranch && remote.publishedSha) {
    return { branch: remote.integrationBranch, pinnedSha: remote.publishedSha };
  }
  return null;
}
function planSync(input) {
  if (!input.remoteReachable)
    return { kind: "unreachable" };
  if (input.remote === null || input.remote.id === input.localCheckpointId) {
    return { kind: "up_to_date" };
  }
  if (!input.worktreeClean)
    return { kind: "diverged_dirty", target: input.remote };
  const target = syncTarget(input.remote);
  if (!target)
    return { kind: "ahead_publishing", target: input.remote };
  return { kind: "fast_forward", target: input.remote, branch: target.branch, pinnedSha: target.pinnedSha };
}
async function runSync(deps) {
  const queue = deps.readQueue();
  const syncedRemote = deps.readSyncedRemote();
  const localCheckpointId = resolveParentCheckpointId(queue, syncedRemote);
  const result = await deps.fetchRemote();
  const porcelain = deps.git(["status", "--porcelain"]);
  const worktreeClean = !hasChanges(porcelain);
  const action = planSync({
    localCheckpointId,
    remote: result.ok ? result.latest : null,
    worktreeClean,
    remoteReachable: result.ok
  });
  const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
  switch (action.kind) {
    case "unreachable":
      return { action, message: "sync remoto indispon\xEDvel (timeout/rede) \u2014 seguindo com o estado local." };
    case "up_to_date":
      if (result.ok && result.latest) {
        deps.writeSyncedRemote({
          checkpointId: result.latest.id,
          createdAt: result.latest.createdAt,
          checkedAt: nowIso()
        });
      }
      return { action, message: "j\xE1 sincronizado com o estado mais recente conhecido." };
    case "diverged_dirty":
      return {
        action,
        message: `existe um checkpoint mais novo publicado ("${action.target.summary}") e este worktree tem altera\xE7\xF5es n\xE3o salvas \u2014 nada foi sobrescrito. Feche o pedido com um checkpoint normal e a sincroniza\xE7\xE3o segue no pr\xF3ximo.`
      };
    case "ahead_publishing":
      return {
        action,
        message: `existe um checkpoint mais novo ("${action.target.summary}") ainda sendo publicado pelo Supremo \u2014 sincroniza sozinho assim que a branch ficar dispon\xEDvel.`
      };
    case "fast_forward": {
      try {
        deps.git(["fetch", "origin", action.branch]);
        deps.git(["merge", "--ff-only", action.pinnedSha ?? `origin/${action.branch}`]);
      } catch {
        return {
          action,
          message: "n\xE3o foi poss\xEDvel sincronizar automaticamente (fast-forward indispon\xEDvel) \u2014 nada foi alterado; sincronize manualmente quando puder."
        };
      }
      deps.writeSyncedRemote({
        checkpointId: action.target.id,
        createdAt: action.target.createdAt,
        checkedAt: nowIso()
      });
      return { action, message: `sincronizado automaticamente com "${action.target.summary}".` };
    }
  }
}
function readSyncedRemoteState(cwd) {
  try {
    return JSON.parse(import_node_fs6.default.readFileSync(import_node_path6.default.join(cwd, SYNC_STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}
function defaultSyncDeps(base, cwd, fetchRemote) {
  const statePath = import_node_path6.default.join(cwd, SYNC_STATE_FILE);
  return {
    ...base,
    fetchRemote,
    readSyncedRemote: () => readSyncedRemoteState(cwd),
    writeSyncedRemote: (state) => {
      import_node_fs6.default.mkdirSync(import_node_path6.default.dirname(statePath), { recursive: true });
      import_node_fs6.default.writeFileSync(statePath, JSON.stringify(state));
    }
  };
}
var import_node_fs6, import_node_path6, SYNC_STATE_FILE;
var init_sync = __esm({
  "src/sync.ts"() {
    "use strict";
    import_node_fs6 = __toESM(require("node:fs"));
    import_node_path6 = __toESM(require("node:path"));
    init_checkpoint();
    SYNC_STATE_FILE = `${CHECKPOINT_DIR}/synced-remote.json`;
  }
});

// src/database.ts
var database_exports = {};
__export(database_exports, {
  runDatabase: () => runDatabase,
  validateLocalTarget: () => validateLocalTarget
});
function validateLocalTarget(cwd, status) {
  if (status.environment !== "development" || !status.automaticMigrations || !status.projectRef) {
    throw new Error("Banco n\xE3o reconhecido como development pelo Supremo. Produ\xE7\xE3o e ambiente desconhecido est\xE3o protegidos.");
  }
  const linked = import_node_fs7.default.readFileSync(import_node_path7.default.join(cwd, "supabase/.temp/project-ref"), "utf8").trim();
  const env = import_node_fs7.default.readFileSync(import_node_path7.default.join(cwd, ".env.local"), "utf8");
  const url = /^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^\s"']+)/m.exec(env)?.[1];
  if (linked !== status.projectRef || url !== `https://${status.projectRef}.supabase.co`) {
    throw new Error("O banco do preview ou o link local diverge do development registrado. Nenhuma altera\xE7\xE3o foi enviada.");
  }
  return status.projectRef;
}
async function runDatabase(operation, cwd = process.cwd()) {
  const config = readProjectConfig(cwd);
  if (!config)
    throw new Error("Execute o bootstrap para identificar o projeto.");
  const secret = resolveKeychain().get(config.projectId);
  if (!secret)
    throw new Error("Dispositivo sem autoriza\xE7\xE3o. Execute o bootstrap.");
  const url = new URL("/api/database", config.apiBaseUrl);
  if (url.protocol !== "https:" && !(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:")) {
    throw new Error("O endpoint do Supremo deve usar HTTPS.");
  }
  const request = async (op, extra = {}) => {
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceSecret: secret, projectId: config.projectId, operation: op, ...extra }),
      signal: AbortSignal.timeout(6e4)
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(data.error ?? `Banco indispon\xEDvel (HTTP ${res.status}).`);
    return data;
  };
  const status = await request("status");
  import_node_fs7.default.writeFileSync(import_node_path7.default.join(cwd, ".supremo/database.json"), JSON.stringify(status, null, 2) + "\n");
  if (operation === "status")
    return status;
  const expectedRef = validateLocalTarget(cwd, status);
  if (operation === "anonymous-auth")
    return request(operation, { expectedRef });
  const directory = import_node_path7.default.join(cwd, "supabase/migrations");
  const migrations = import_node_fs7.default.readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => ({
    path: `supabase/migrations/${name}`,
    content: import_node_fs7.default.readFileSync(import_node_path7.default.join(directory, name), "utf8")
  }));
  return request(operation, { expectedRef, migrations });
}
var import_node_fs7, import_node_path7;
var init_database = __esm({
  "src/database.ts"() {
    "use strict";
    import_node_fs7 = __toESM(require("node:fs"));
    import_node_path7 = __toESM(require("node:path"));
    init_daemon();
    init_keychain();
  }
});

// node_modules/commander/esm.mjs
var import_index = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  // deprecated old name
  Command,
  Argument,
  Option,
  Help
} = import_index.default;

// package.json
var package_default = {
  name: "supremo-cli",
  version: "1.3.0",
  description: "CLI do Supremo: bootstrap, preview persistente e checkpoints em background.",
  license: "MIT",
  author: "Supremo",
  homepage: "https://supremo-three.vercel.app",
  repository: {
    type: "git",
    url: "git+https://github.com/ahmedhijazi94/devsupremo.git",
    directory: "packages/cli"
  },
  keywords: [
    "supremo",
    "bootstrap",
    "scaffold",
    "cli",
    "device-flow"
  ],
  bin: {
    supremo: "./dist/bin.js"
  },
  files: [
    "dist",
    "README.md"
  ],
  engines: {
    node: ">=18"
  },
  publishConfig: {
    access: "public"
  },
  scripts: {
    build: "esbuild src/bin.ts --bundle --platform=node --target=node18 --outfile=dist/bin.js",
    prepublishOnly: "npm run build",
    start: "node dist/bin.js",
    test: "vitest run"
  },
  "//": "Sem dependencies de runtime: o esbuild empacota tudo em dist/bin.js (self-contained), ent\xE3o o npx s\xF3 baixa o bundle. Estas ficam em devDependencies porque o build precisa empacot\xE1-las.",
  devDependencies: {
    commander: "^12.1.0",
    dotenv: "^16.4.5",
    "@types/node": "^20.12.7",
    esbuild: "^0.20.2",
    typescript: "^5.4.5"
  }
};

// src/command-guard.ts
var KNOWN_COMMANDS = ["bootstrap", "checkpoint", "daemon", "sync", "db"];
function isKnownOrGlobal(firstArg) {
  if (!firstArg)
    return true;
  if (firstArg.startsWith("-"))
    return true;
  return KNOWN_COMMANDS.includes(firstArg);
}
function unknownCommandMessage(attempted) {
  const listed = KNOWN_COMMANDS.join(", ");
  return `\u2717 Comando desconhecido: "${attempted}".
  Comandos dispon\xEDveis: ${listed}
  Se voc\xEA atualizou o Supremo recentemente, sua CLI local pode estar
  desatualizada (o \`npx\` \xE0s vezes reusa uma vers\xE3o em cache) \u2014 rode de novo
  com \`npx --yes supremo-cli@latest ${attempted} ...\`.`;
}

// src/bin.ts
var program2 = new Command();
program2.name("supremo").description("CLI do Supremo (bootstrap, checkpoints e desenvolvimento local)").version(package_default.version);
function guardUnknownCommand(argv) {
  const first = argv[0];
  if (isKnownOrGlobal(first))
    return;
  console.error(unknownCommandMessage(first));
  process.exit(1);
}
program2.command("bootstrap <project-id>").description("Prepara o workspace local do projeto (autoriza no navegador)").requiredOption("-u, --url <url>", "URL do Supremo, ex.: https://supremo.app").option("-d, --dir <dir>", "Pasta-base onde criar o projeto (padr\xE3o: pasta atual)").option("--start", "(sem efeito \u2014 preview e daemon j\xE1 sobem sempre; aceito por compatibilidade)").action(
  async (projectId, options) => {
    const { runBootstrap: runBootstrap2 } = await Promise.resolve().then(() => (init_bootstrap(), bootstrap_exports));
    try {
      await runBootstrap2({
        projectId,
        url: options.url,
        dir: options.dir,
        start: options.start
      });
    } catch (error) {
      console.error(
        `
\u2717 ${error instanceof Error ? error.message : String(error)}
`
      );
      process.exit(1);
    }
  }
);
program2.command("checkpoint <summary...>").description("Cria um checkpoint LOCAL do pedido conclu\xEDdo (sem rede)").option("--conversation-id <id>", "ID da conversa, se o host fornecer").option("--message-id <id>", "ID da mensagem/turno, se o host fornecer").option("--origin-agent <name>", "Nome do agente (ex.: claude, codex)").action(async (summaryParts, options) => {
  const { runCheckpoint: runCheckpoint2, defaultCheckpointDeps: defaultCheckpointDeps2, readProjectId: readProjectId2, NothingToCheckpointError: NothingToCheckpointError2 } = await Promise.resolve().then(() => (init_checkpoint(), checkpoint_exports));
  const cwd = process.cwd();
  const projectId = readProjectId2(cwd);
  if (!projectId) {
    console.error("\u2717 .supremo/project.json ausente \u2014 rode o bootstrap primeiro.");
    process.exit(1);
  }
  const summary = summaryParts.join(" ").trim();
  if (!summary) {
    console.error('\u2717 Informe um resumo: supremo checkpoint "home minimalista"');
    process.exit(1);
  }
  try {
    const { ensureDaemon: ensureDaemon2 } = await Promise.resolve().then(() => (init_daemon(), daemon_exports));
    try {
      ensureDaemon2(cwd);
    } catch {
    }
    const { resolveParentCheckpointId: resolveParentCheckpointId2, readSyncedRemoteState: readSyncedRemoteState2 } = await Promise.resolve().then(() => (init_sync(), sync_exports));
    const deps = defaultCheckpointDeps2(cwd);
    const parentCheckpointIdOverride = resolveParentCheckpointId2(
      deps.readQueue(),
      readSyncedRemoteState2(cwd)
    );
    const record = runCheckpoint2(summary, projectId, deps, {
      conversationId: options.conversationId,
      messageId: options.messageId,
      originAgent: options.originAgent,
      parentCheckpointIdOverride
    });
    console.log(
      `\u2713 checkpoint ${record.checkpointId.slice(0, 8)} (${record.riskLevel}) \u2014 push em background. Pode pedir a pr\xF3xima mudan\xE7a.`
    );
  } catch (error) {
    if (error instanceof NothingToCheckpointError2) {
      console.log("\u2022 Nada mudou \u2014 nenhum checkpoint criado.");
      return;
    }
    console.error(`\u2717 ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
});
program2.command("daemon").description("Checkpoint daemon: envia checkpoints em background (push/PR)").option("--ensure", "Garante o daemon vivo (sobe desacoplado se preciso)").option("--status", "Mostra se o daemon est\xE1 rodando").option("--stop", "Para o daemon").option("--once", "Drena a fila uma vez e sai (debug/CI)").action(
  async (options) => {
    const daemon = await Promise.resolve().then(() => (init_daemon(), daemon_exports));
    const cwd = process.cwd();
    if (options.status) {
      console.log(JSON.stringify(daemon.daemonStatus(cwd)));
      return;
    }
    if (options.stop) {
      daemon.stopDaemon(cwd);
      console.log("daemon parado.");
      return;
    }
    if (options.ensure) {
      const r = daemon.ensureDaemon(cwd);
      console.log(r === "reuse" ? "\u2713 daemon j\xE1 ativo" : "\u2713 daemon iniciado");
      return;
    }
    if (options.once) {
      const cfg = daemon.readProjectConfig(cwd);
      if (!cfg) {
        console.error("\u2717 .supremo/project.json ausente/incompleto.");
        process.exit(1);
      }
      const keychainModule = await Promise.resolve().then(() => (init_keychain(), keychain_exports));
      const kc = keychainModule.resolveKeychain();
      const n = await daemon.drainOnce({
        projectId: cfg.projectId,
        apiBaseUrl: cfg.apiBaseUrl,
        cwd,
        getSecret: () => kc.get(cfg.projectId)
      });
      console.log(`processados: ${n}`);
      return;
    }
    await daemon.runDaemonLoop(cwd);
  }
);
program2.command("sync").description(
  "Sincroniza\xE7\xE3o entre m\xE1quinas: religa a este worktree ao checkpoint mais recente conhecido do projeto (fast-forward seguro se poss\xEDvel). Rode UMA vez no primeiro pedido da sess\xE3o, depois de `daemon --ensure`/preview."
).action(async () => {
  const cwd = process.cwd();
  const [{ readProjectId: readProjectId2, defaultCheckpointDeps: defaultCheckpointDeps2 }, daemon, sync] = await Promise.all([
    Promise.resolve().then(() => (init_checkpoint(), checkpoint_exports)),
    Promise.resolve().then(() => (init_daemon(), daemon_exports)),
    Promise.resolve().then(() => (init_sync(), sync_exports))
  ]);
  const projectId = readProjectId2(cwd);
  const cfg = daemon.readProjectConfig(cwd);
  if (!projectId || !cfg) {
    console.log(
      JSON.stringify({
        action: "up_to_date",
        message: "projeto ainda n\xE3o inicializado \u2014 nada a sincronizar."
      })
    );
    return;
  }
  const keychainModule = await Promise.resolve().then(() => (init_keychain(), keychain_exports));
  const kc = keychainModule.resolveKeychain();
  const deviceSecret = kc.get(cfg.projectId);
  const http = daemon.defaultDaemonHttp(cfg.apiBaseUrl);
  const outcome = await sync.runSync(
    sync.defaultSyncDeps(defaultCheckpointDeps2(cwd), cwd, async () => {
      if (!deviceSecret)
        return { ok: false };
      try {
        const result = await http.syncStatus({ deviceSecret, projectId: cfg.projectId });
        return { ok: true, latest: result.latest };
      } catch {
        return { ok: false };
      }
    })
  );
  console.log(JSON.stringify({ action: outcome.action.kind, message: outcome.message }));
});
program2.command("db <operation>").description("Banco development: status, migrate ou anonymous-auth (autoridade do servidor)").action(async (operation) => {
  try {
    if (operation !== "status" && operation !== "migrate" && operation !== "anonymous-auth") {
      throw new Error("Use db status, db migrate ou db anonymous-auth.");
    }
    const database = await Promise.resolve().then(() => (init_database(), database_exports));
    console.log(JSON.stringify(await database.runDatabase(operation)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Falha ao acessar o banco.");
    process.exitCode = 1;
  }
});
guardUnknownCommand(process.argv.slice(2));
if (process.argv.length === 2)
  program2.outputHelp();
else
  program2.parse();
