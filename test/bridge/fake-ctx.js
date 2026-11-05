/**
 * Fake cordis context for agent-bridge unit tests.
 *
 * Provides a minimal `ctx.agents` registry (live lookup, create, resume), a
 * cordis-like `ctx.on`/event emitter, scriptable fake Agents, and a live
 * `agent/status` / `agent/error` stream. No DSH host, no network, no model.
 */

import { EventEmitter } from 'node:events';

/**
 * @typedef {(context: { agent: FakeAgent, ctx: object, message: object }) => void | Promise<void>} Behavior
 */

class FakeAgent {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.session = { id, seq: 0 };
    this.status = 'idle';
    this.inbox = [];
    this.cancelled = [];
    this._idleWaiters = [];
    this._activity = Promise.resolve();
  }

  /** Append one session event and feed it to the fake event bus. */
  emit(type, data = {}) {
    const event = { type, seq: this.session.seq, time: Date.now(), data };
    this.session.seq += 1;
    this.ctx.emit('session/event', this.session, event);
    return event;
  }

  followup(message) {
    this.inbox.push(message);
    this.status = 'running';
    this.ctx.emit('agent/status', { agent: this, status: 'running' });
    const behavior = this.ctx.behaviors.get(this.id) || this.ctx.defaultBehavior;
    this._activity = Promise.resolve()
      .then(() => behavior({ agent: this, ctx: this.ctx, message }))
      .catch((error) => {
        // The real loop contains a driver failure and reports it as agent/error.
        this.ctx.emit('agent/error', { agent: this, error, turn: 1, step: 1 });
      })
      .finally(() => {
        this.status = 'idle';
        this.ctx.emit('agent/status', { agent: this, status: 'idle' });
        const waiters = this._idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      });
    this._activity.catch(() => undefined);
  }

  whenIdle() {
    if (this.status === 'idle') return Promise.resolve();
    return new Promise((resolve) => {
      this._idleWaiters.push(resolve);
    });
  }

  cancel(cause) {
    this.cancelled.push(cause);
    this.status = 'idle';
    const waiters = this._idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function defaultBehavior() {
  return async ({ agent }) => {
    agent.emit('turn/start', { turn: 1 });
    agent.emit('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'fake reply' }] },
    });
    agent.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  };
}

/**
 * Build a fake cordis context.
 *
 * @param {object} [options]
 * @param {Behavior} [options.defaultBehavior] default behavior used on followup.
 * @param {object} [options.agentDefaultModel] fake `agentDefaultModel` service.
 * @param {Iterable<string>} [options.failResumeIds] session ids whose resume rejects.
 * @param {boolean} [options.failCreate] make `ctx.agents.create` reject.
 * @returns {object} fake context (see fields below).
 */
export function createFakeCtx(options = {}) {
  const emitter = new EventEmitter();
  const registry = new Map();

  const attach = (agent, handle) => {
    registry.set(agent.id, { agent, handle });
    return handle;
  };

  const makeOwnedAgent = (id) => {
    const agent = new FakeAgent(ctx, id);
    const handle = {
      agent,
      dispose: async () => {
        ctx.disposeCalls.push(id);
        registry.delete(id);
      },
    };
    return attach(agent, handle);
  };

  const ctx = {
    createCalls: [],
    resumeCalls: [],
    disposeCalls: [],
    behaviors: new Map(),
    defaultBehavior: options.defaultBehavior || defaultBehavior(),
    failResumeIds: new Set(options.failResumeIds || []),
    failCreate: Boolean(options.failCreate),
    agentDefaultModel: options.agentDefaultModel,
    services: options.services || {},
    /** Cordis-style service lookup used by the bridge's default-model resolution. */
    get(name) {
      if (ctx.services && Object.prototype.hasOwnProperty.call(ctx.services, name)) return ctx.services[name];
      if (name === 'agentDefaultModel') return ctx.agentDefaultModel;
      return undefined;
    },
    on(event, listener) {
      emitter.on(event, listener);
      return () => emitter.off(event, listener);
    },
    emit(event, ...args) {
      emitter.emit(event, ...args);
    },
    /** Number of active listeners, used to assert disposal removed subscriptions. */
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
    /** Register an agent that belongs to the host (e.g. opened in the Web UI). */
    addLiveAgent(sessionId) {
      const agent = new FakeAgent(ctx, sessionId);
      attach(agent, undefined);
      return agent;
    },
    /** True when the host registry still contains this live agent. */
    hasLiveAgent(sessionId) {
      return registry.has(sessionId);
    },
    agents: {
      get(id) {
        const entry = registry.get(id);
        return entry ? entry.agent : undefined;
      },
      async create(createOptions) {
        ctx.createCalls.push(createOptions);
        if (ctx.failCreate) throw new Error('create failed');
        const id = createOptions.sessionId;
        if (registry.has(id)) throw new Error('agent ' + id + ' is already registered');
        return makeOwnedAgent(id);
      },
      async resume(resumeOptions) {
        ctx.resumeCalls.push(resumeOptions);
        const id = resumeOptions.resumeSessionId;
        if (ctx.failResumeIds.has(id)) throw new Error('no persisted session ' + id);
        if (registry.has(id)) throw new Error('session ' + id + ' is occupied');
        return makeOwnedAgent(id);
      },
      list() {
        return [...registry.values()].map((entry) => entry.agent);
      },
    },
  };
  return ctx;
}

/** Behavior that emits one scripted sequence of session events. */
export function behavior(steps) {
  return async ({ agent, ctx }) => {
    for (const step of steps) {
      if (typeof step === 'function') {
        await step({ agent, ctx });
        continue;
      }
      if (step.type === 'wait') {
        await step.promise;
        continue;
      }
      agent.emit(step.type, step.data || {});
    }
  };
}

/** Behavior for one completed turn with optional tools and assistant texts. */
export function turnBehavior({ assistant = 'fake reply', tools = [], reason = { kind: 'completed' } } = {}) {
  const steps = [{ type: 'turn/start', data: { turn: 1 } }];
  for (const tool of tools) {
    steps.push({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: tool.callId, name: tool.name, arguments: tool.arguments },
    });
    steps.push({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { toolCallId: tool.callId, isError: Boolean(tool.isError), content: [] },
      },
    });
  }
  if (assistant !== undefined && assistant !== null) {
    steps.push({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: assistant }] },
      },
    });
  }
  steps.push({ type: 'turn/end', data: { turn: 1, reason } });
  return behavior(steps);
}
