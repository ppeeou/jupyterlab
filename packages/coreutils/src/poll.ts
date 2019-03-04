// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PromiseDelegate } from '@phosphor/coreutils';

import { IDisposable } from '@phosphor/disposable';

import { ISignal, Signal } from '@phosphor/signaling';

/**
 * A class that wraps an asynchronous function to poll at a regular interval
 * with exponential increases to the interval length if the poll fails.
 *
 * #### Notes
 * The generic argument `T` indicates the resolved type of the promises returned
 * by the poll's promise factory.
 */
export class Poll<T = any> implements IDisposable {
  /**
   * Instantiate a new poll with exponential back-off in case of failure.
   *
   * @param options - The poll instantiation options.
   */
  constructor(options: Poll.IOptions<T>) {
    const { factory, interval, max, min, name, variance, when } = options;

    if (interval > max) {
      throw new Error('Poll interval cannot exceed max interval length');
    }
    if (min > max || min > interval) {
      throw new Error('Poll min cannot exceed poll interval or poll max');
    }

    this.interval =
      typeof interval === 'number' ? Math.round(Math.abs(interval)) : 1000;
    this.max = typeof max === 'number' ? Math.abs(max) : 10 * this.interval;
    this.min = typeof min === 'number' ? Math.abs(min) : 100;
    this.name = name || 'unknown';
    this.variance = typeof variance === 'number' ? variance : 0.2;
    this._connected = false;
    this._factory = factory;

    // Create the initial outstanding next poll promise.
    const next = new PromiseDelegate<Poll.Next>();
    this._outstanding = next;
    (when || Promise.resolve())
      .then(() => {
        this._connected = true;
        this._outstanding = null;
        next.resolve(this._schedule(interval));
      })
      .catch(() => {
        this._outstanding = null;
        next.resolve(this._schedule(interval));
      });
  }

  /**
   * The polling interval.
   */
  readonly interval: number;

  /**
   * The maximum interval between poll requests.
   */
  readonly max: number;

  /**
   * The minimum interval between poll requests.
   */
  readonly min: number;

  /**
   * The name of the poll. Defaults to `'unknown'`.
   */
  readonly name: string;

  /**
   * The range within which the poll interval jitters.
   */
  readonly variance: number;

  /**
   * A signal emitted when the poll is disposed.
   */
  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * Whether the poll is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A handle to the next link in the poll promise chain.
   */
  get next(): Poll.Next {
    return this._outstanding || this._schedule(this.interval);
  }

  /**
   * A signal emitted when the poll promise rejects.
   */
  get rejected(): ISignal<this, any> {
    return this._rejected;
  }

  /**
   * A signal emitted when the poll promise successfully resolves.
   */
  get resolved(): ISignal<this, T> {
    return this._resolved;
  }

  /**
   * The most recently recorded poll tick time.
   */
  get tick(): number {
    return this._tick;
  }

  /**
   * A signal emitted when the poll ticks.
   */
  get ticked(): ISignal<this, number> {
    return this._ticked;
  }

  /**
   * Dispose the poll, stop executing future poll requests.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._disposed.emit();
    Signal.clearData(this);
    if (this._outstanding) {
      const outstanding = this._outstanding;
      this._outstanding = null;
      outstanding.reject(new Error(`Poll (${this.name}) is disposed.`));
    }
  }

  /**
   * Refresh the poll.
   */
  refresh(): Poll.Next {
    return this._schedule(0, 'override');
  }

  /**
   * Execute a poll request.
   */
  private _execute(
    delegate: PromiseDelegate<Poll.Next>,
    interval: number,
    schedule: Poll.Schedule
  ): void {
    if (this._isDisposed) {
      return;
    }

    // Reschedule without executing poll promise if application is hidden.
    if (typeof document !== 'undefined' && document.hidden) {
      this._outstanding = null;
      delegate.resolve(this._schedule(interval, 'standby'));
      return;
    }

    const { max, min, variance } = this;
    const connected = this._connected;
    const promise = this._factory({ connected, interval, schedule });

    promise
      .then((payload: T) => {
        // Bail if disposed while poll promise was in flight.
        if (this._isDisposed) {
          return;
        }

        // Bail if this promise has already been superseded.
        if (this._outstanding !== delegate) {
          return;
        }

        // Note if this is a reconnection.
        if (!this._connected) {
          console.log(`Poll (${this.name}) reconnected.`);
        }

        // Set current poll state.
        this._connected = true;
        this._outstanding = null;
        this._tick = new Date().getTime();

        // The poll succeeded. Reset the interval.
        interval = Private.jitter(this.interval, variance, min, max);

        // Schedule the next poll.
        delegate.resolve(this._schedule(interval));

        // Emit the current tick.
        this._ticked.emit(this._tick);

        // Emit the promise resolution's payload.
        this._resolved.emit(payload);
      })
      .catch((reason: any) => {
        // Bail if disposed while poll promise was in flight.
        if (this._isDisposed) {
          return;
        }

        // Bail if this promise has already been superseded.
        if (this._outstanding !== delegate) {
          return;
        }

        // Set current poll state.
        this._connected = false;
        this._outstanding = null;
        this._tick = new Date().getTime();

        // The poll failed. Increase the interval.
        const old = interval;
        const increased = Math.min(interval * 2, max);
        interval = Private.jitter(increased, variance, min, max);
        console.warn(
          `Poll (${
            this.name
          }) failed, increasing interval from ${old} to ${interval}.`,
          reason
        );

        // Schedule the next poll.
        delegate.resolve(this._schedule(interval));

        // Emit the current tick.
        this._ticked.emit(this._tick);

        // Emit the promise rejection's error payload.
        this._rejected.emit(reason);
      });
  }

  /**
   * Schedule a poll request and return the next link in the promise chain,
   * disrupting the outstanding poll if necessary.
   *
   * #### Notes
   * The next poll promise returned is guaranteed to always resolve with a
   * handle on the correct next link in the poll promise chain except when the
   * poll is disposed.
   */
  private _schedule(
    interval: number,
    schedule: Poll.Schedule = 'automatic'
  ): Poll.Next {
    const outstanding = this._outstanding;

    // If poll is being overridden, generate a new poll.
    if (schedule === 'override' && outstanding) {
      // Reset the previously outstanding poll and generate the next poll.
      this._outstanding = null;
      const next = this._schedule(0, 'override');

      // Short-circuit the previous poll promise and return a reference to the
      // next poll promise (which supersedes it) scheduled to run immediately.
      outstanding.resolve(next);

      return next;
    }

    // If there is already an outstanding poll, return a reference to it.
    if (outstanding) {
      return outstanding;
    }

    // Create a new promise delegate and set the outstanding reference.
    const delegate = new PromiseDelegate<Poll.Next>();
    this._outstanding = delegate;

    // Schedule the poll request.
    if (interval) {
      setTimeout(() => {
        this._execute(delegate, interval, schedule);
      }, interval);
    } else {
      requestAnimationFrame(() => {
        this._execute(delegate, interval, schedule);
      });
    }

    return delegate;
  }

  private _connected: boolean;
  private _disposed = new Signal<this, void>(this);
  private _factory: (state: Poll.State) => Promise<any>;
  private _isDisposed = false;
  private _outstanding: PromiseDelegate<Poll.Next> | null = null;
  private _rejected = new Signal<this, any>(this);
  private _resolved = new Signal<this, T>(this);
  private _tick = new Date().getTime();
  private _ticked = new Signal<this, number>(this);
}

/**
 * A namespace for `Poll` class statics, types, and interfaces.
 */
export namespace Poll {
  /**
   * A poll promise that resolves to the next scheduled poll promise.
   */
  export type Next = { promise: Promise<Next> };

  /**
   * Whether polling was scheduled automatically, overridden, or from standby.
   */
  export type Schedule = 'automatic' | 'override' | 'standby';
  /**
   * Definition of poll state that gets passed into the poll promise factory.
   */
  export type State = {
    /**
     * Whether the last poll succeeded.
     */
    readonly connected: boolean;

    /**
     * The number of milliseconds that elapsed since the last poll.
     */
    readonly interval: number;

    /**
     * Whether polling was scheduled automatically, overridden, or from standby.
     */
    readonly schedule: Schedule;
  };

  /**
   * Instantiation options for polls.
   */
  export interface IOptions<T> {
    /**
     * The millisecond interval between poll requests.
     *
     * #### Notes
     * If set to `0`, the poll will schedule an animation frame after each
     * promise resolution.
     */
    interval: number;

    /**
     * The maximum interval to wait between polls. Defaults to `10 * interval`.
     */
    max?: number;

    /**
     * The minimum interval to wait between polls. Defaults to `100`.
     */
    min?: number;

    /**
     * The name of the poll. Defaults to `'unknown'`.
     */
    name?: string;

    /**
     * A factory function that is passed poll state and returns a poll promise.
     *
     * #### Notes
     * The generic type argument `T` is the poll promise resolution's payload.
     *
     * It is safe to ignore the state argument.
     */
    factory: (state: Poll.State) => Promise<T>;

    /**
     * If set, a promise which must resolve (or reject) before polling begins.
     */
    when?: Promise<any>;

    /**
     * The range within which the poll interval jitters. Defaults to `0.2`.
     *
     * #### Notes
     * Unless set to `0` the poll interval will be irregular.
     */
    variance?: number;
  }
}

/**
 * A namespace for private module data.
 */
namespace Private {
  /**
   * Returns a randomly jittered integer value.
   *
   * @param base - The base value that is being wobbled.
   *
   * @param factor - Factor multiplied by the base to define jitter amplitude.
   * A factor of `0` will return the base unchanged.
   *
   * @param min - The smallest acceptable value to return.
   *
   * @param max - The largest acceptable value to return.
   *
   * #### Notes
   * This function returns only positive integers.
   */
  export function jitter(
    base: number,
    factor: number,
    min: number,
    max: number
  ): number {
    if (factor === 0) {
      return Math.floor(base);
    }

    const direction = Math.random() < 0.5 ? 1 : -1;
    const jitter = Math.random() * base * Math.abs(factor) * direction;
    const candidate = Math.abs(Math.floor(base + jitter));

    return Math.min(Math.max(min, candidate), max);
  }
}
