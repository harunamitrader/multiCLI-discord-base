import { EventEmitter } from "node:events";

export class EventBus {
  constructor() {
    this.emitter = new EventEmitter();
    this.clients = new Set();
    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        client.response.write(": ping\n\n");
      }
    }, 15000);
  }

  on(eventName, handler) {
    this.emitter.on(eventName, handler);
    return () => this.emitter.off(eventName, handler);
  }

  publish(eventName, payload) {
    this.emitter.emit(eventName, payload);

    const body = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      client.response.write(body);
    }
  }

  addSseClient(response) {
    const client = { response };
    this.clients.add(client);
    response.write(": connected\n\n");

    return () => {
      this.clients.delete(client);
    };
  }

  close() {
    clearInterval(this.pingInterval);
    for (const client of this.clients) {
      client.response.end();
    }
    this.clients.clear();
  }
}
