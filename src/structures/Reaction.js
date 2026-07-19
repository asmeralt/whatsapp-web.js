'use strict';

const Base = require('./Base');

/**
 * Represents a Reaction on WhatsApp
 * @extends {Base}
 */
class Reaction extends Base {
    constructor(client, data) {
        super(client);

        if (data) this._patch(data);
    }

    _patch(data) {
        // Recent WhatsApp Web builds expose the serialized ID on message
        // keys as `$1` instead of `_serialized`; restore the legacy
        // property the public API promises.
        const normalizeKey = (key) => {
            if (
                key &&
                typeof key === 'object' &&
                key._serialized === undefined &&
                typeof key.$1 === 'string'
            ) {
                key._serialized = key.$1;
            }
            return key;
        };

        /**
         * Reaction ID
         * @type {object}
         */
        this.id = normalizeKey(data.msgKey);
        /**
         * Orphan
         * @type {number}
         */
        this.orphan = data.orphan;
        /**
         * Orphan reason
         * @type {?string}
         */
        this.orphanReason = data.orphanReason;
        /**
         * Unix timestamp for when the reaction was created
         * @type {number}
         */
        this.timestamp = data.timestamp;
        /**
         * Reaction
         * @type {string}
         */
        this.reaction = data.reactionText;
        /**
         * Read
         * @type {boolean}
         */
        this.read = data.read;
        /**
         * Message ID
         * @type {object}
         */
        this.msgId = normalizeKey(data.parentMsgKey);
        /**
         * Sender ID
         * @type {string}
         */
        this.senderId =
            data.senderUserJid && typeof data.senderUserJid === 'object'
                ? (data.senderUserJid._serialized ?? data.senderUserJid.$1)
                : data.senderUserJid;
        /**
         * ACK
         * @type {?number}
         */
        this.ack = data.ack;

        return super._patch(data);
    }
}

module.exports = Reaction;
