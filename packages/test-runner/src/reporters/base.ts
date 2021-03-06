/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { codeFrameColumns } from '@babel/code-frame';
import colors from 'colors/safe';
import fs from 'fs';
import milliseconds from 'ms';
import path from 'path';
import StackUtils from 'stack-utils';
import { Reporter, RunnerConfig, Suite, Test, TestResult, Configuration } from '../runner';

const stackUtils = new StackUtils();

export class BaseReporter implements Reporter  {
  skipped: Test[] = [];
  asExpected: Test[] = [];
  unexpected = new Set<Test>();
  expectedFlaky: Test[] = [];
  unexpectedFlaky: Test[] = [];
  duration = 0;
  startTime: number;
  config: RunnerConfig;
  suite: Suite;
  timeout: number;

  constructor() {
    process.on('SIGINT', async () => {
      this.onEnd();
      this.epilogue();
      process.exit(130);
    });
  }

  onBegin(config: RunnerConfig, suite: Suite) {
    this.startTime = Date.now();
    this.config = config;
    this.suite = suite;
  }

  onTestBegin(test: Test) {
  }

  onTestStdOut(test: Test, chunk: string | Buffer) {
    if (!this.config.quiet)
      process.stdout.write(chunk);
  }

  onTestStdErr(test: Test, chunk: string | Buffer) {
    if (!this.config.quiet)
      process.stderr.write(chunk);
  }

  onTestEnd(test: Test, result: TestResult) {
    if (result.status === 'skipped') {
      this.skipped.push(test);
      return;
    }

    if (result.status === result.expectedStatus) {
      if (test.results.length === 1) {
        // as expected from the first attempt
        this.asExpected.push(test);
      } else {
        // as expected after unexpected -> flaky.
        if (test.isFlaky())
          this.expectedFlaky.push(test);
        else
          this.unexpectedFlaky.push(test);
      }
      return;
    }
    if (result.status === 'passed' || result.status === 'timedOut' || test.results.length === this.config.retries + 1) {
      // We made as many retries as we could, still failing.
      this.unexpected.add(test);
    }
  }

  onTimeout(timeout: number) {
    this.timeout = timeout;
  }

  onEnd() {
    this.duration = Date.now() - this.startTime;
  }

  epilogue() {
    console.log('');

    console.log(colors.green(`  ${this.asExpected.length} passed`) + colors.dim(` (${milliseconds(this.duration)})`));

    if (this.skipped.length)
      console.log(colors.yellow(`  ${this.skipped.length} skipped`));

    const filteredUnexpected = [...this.unexpected].filter(t => !t._hasResultWithStatus('timedOut'));
    if (filteredUnexpected.length) {
      console.log(colors.red(`  ${filteredUnexpected.length} failed`));
      console.log('');
      this._printFailures(filteredUnexpected);
    }

    if (this.expectedFlaky.length)
      console.log(colors.yellow(`  ${this.expectedFlaky.length} expected flaky`));

    if (this.unexpectedFlaky.length) {
      console.log(colors.red(`  ${this.unexpectedFlaky.length} unexpected flaky`));
      if (this.unexpectedFlaky.length) {
        console.log('');
        this._printFailures(this.unexpectedFlaky);
      }
    }

    const timedOut = [...this.unexpected].filter(t => t._hasResultWithStatus('timedOut'));
    if (timedOut.length) {
      console.log(colors.red(`  ${timedOut.length} timed out`));
      console.log('');
      this._printFailures(timedOut);
    }
    console.log('');
    if (this.timeout) {
      console.log(colors.red(`  Timed out waiting ${this.timeout / 1000}s for the entire test run`));
      console.log('');
    }
  }

  private _printFailures(failures: Test[]) {
    failures.forEach((test, index) => {
      console.log(this.formatFailure(test, index + 1));
    });
  }

  formatFailure(test: Test, index?: number): string {
    const tokens: string[] = [];
    let relativePath = path.relative(this.config.testDir, test.file) || path.basename(test.file);
    if (test.location.includes(test.file))
      relativePath += test.location.substring(test.file.length);
    const passedUnexpectedlySuffix = test.results[0].status === 'passed' ? ' -- passed unexpectedly' : '';
    const header = `  ${index ? index + ')' : ''} ${relativePath} › ${test.fullTitle()}${passedUnexpectedlySuffix}`;
    tokens.push(colors.bold(colors.red(header)));

    // Print configuration.
    for (let suite = test.parent; suite; suite = suite.parent) {
      if (suite.configuration)
        tokens.push('    ' + ' '.repeat(String(index).length) + colors.gray(serializeConfiguration(suite.configuration)));
    }

    for (const result of test.results) {
      if (result.status === 'passed')
        continue;
      if (result.status === 'timedOut') {
        tokens.push('');
        tokens.push(indent(colors.red(`Timeout of ${test._timeout}ms exceeded.`), '    '));
      } else {
        const stack = result.error.stack;
        if (stack) {
          tokens.push('');
          const messageLocation = result.error.stack.indexOf(result.error.message);
          const preamble = result.error.stack.substring(0, messageLocation + result.error.message.length);
          tokens.push(indent(preamble, '    '));
          const position = positionInFile(stack, test.file);
          if (position) {
            const source = fs.readFileSync(test.file, 'utf8');
            tokens.push('');
            tokens.push(indent(codeFrameColumns(source, {
              start: position,
            },
            { highlightCode: true}
            ), '    '));
          }
          tokens.push('');
          tokens.push(indent(colors.dim(stack.substring(preamble.length + 1)), '    '));
        } else {
          tokens.push('');
          tokens.push(indent(String(result.error), '    '));
        }
      }
      break;
    }
    tokens.push('');
    return tokens.join('\n');
  }
}

function indent(lines: string, tab: string) {
  return lines.replace(/^/gm, tab);
}

function positionInFile(stack: string, file: string): { column: number; line: number; } {
  for (const line of stack.split('\n')) {
    const parsed = stackUtils.parseLine(line);
    if (!parsed)
      continue;
    if (path.resolve(process.cwd(), parsed.file) === file)
      return {column: parsed.column, line: parsed.line};
  }
  return null;
}

function serializeConfiguration(configuration: Configuration): string {
  const tokens = [];
  for (const { name, value } of configuration)
    tokens.push(`${name}=${value}`);
  return tokens.join(', ');
}
