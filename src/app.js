/**
 * The application entry point
 */
'use strict';

require('./bootstrap');
const config = require('config');
const express = require('express');
const jwtAuth = require('tc-core-library-js').middleware.jwtAuthenticator;
const jwt = require('jsonwebtoken');
const _ = require('lodash');
const cors = require('cors');
const bodyParser = require('body-parser');
const { BUS_API_EVENT } = require('./constants');
const helper = require('./common/helper');
const helperService = require('./services/helper');
const logger = require('./common/logger');
const errors = require('./common/errors');
const service = require('./services/BusAPI');
const models = require('./models');
const Kafka = require('no-kafka');

/**
 * Start Kafka consumer.
 * @param {Object} handlers the handlers
 */
function startKafkaConsumer(handlers) {
  // create group consumer
  const options = { groupId: config.KAFKA_GROUP_ID, connectionString: config.KAFKA_URL };
  if (config.KAFKA_CLIENT_CERT && config.KAFKA_CLIENT_CERT_KEY) {
    options.ssl = { cert: config.KAFKA_CLIENT_CERT, key: config.KAFKA_CLIENT_CERT_KEY };
  }
  const consumer = new Kafka.SimpleConsumer(options);

  // data handler
  const dataHandler = (messageSet, topic, partition) => Promise.each(messageSet, (m) => {
    const message = m.message.value.toString('utf8');
    logger.info(`Handle Kafka event message; Topic: ${topic}; Partition: ${partition}; Offset: ${
      m.offset}; Message: ${message}.`);
    // ignore configured Kafka topic prefix
    let topicName = topic;
    if (config.KAFKA_TOPIC_IGNORE_PREFIX && topicName.startsWith(config.KAFKA_TOPIC_IGNORE_PREFIX)) {
      topicName = topicName.substring(config.KAFKA_TOPIC_IGNORE_PREFIX.length);
    }
    // find handler
    const handler = handlers[topicName];
    if (!handler) {
      logger.info(`No handler configured for topic: ${topicName}`);
      // return null to ignore this message
      return null;
    }
    const messageJSON = JSON.parse(message);
    const handlerAsync = Promise.promisify(handler);
    // use handler to create notification instances for each recipient
    return handlerAsync(topicName, messageJSON)
      .then((notifications) => Promise.all(_.map(notifications, (notification) =>
        // save notifications
        models.Notification.create({
          userId: notification.userId,
          type: notification.newType || topicName,
          version: notification.version || null,
          contents: _.extend({}, messageJSON, notification.contents),
          read: false,
          seen: false,
        })
        .then(() => {
          if (config.ENABLE_EMAILS) {
            // if it's interesting event, create email event and send to bus api
            const notificationType = notification.newType || topicName;
            logger.debug(`checking ${notificationType} notification ${JSON.stringify(notification)}`);
            let eventType;

            if (notificationType === BUS_API_EVENT.CONNECT.TOPIC_CREATED) {
              eventType = BUS_API_EVENT.EMAIL.TOPIC_CREATED;
            } else if (notificationType === BUS_API_EVENT.CONNECT.POST_CREATED) {
              eventType = BUS_API_EVENT.EMAIL.POST_CREATED;
            } else if (notificationType === BUS_API_EVENT.CONNECT.MENTIONED_IN_POST) {
              eventType = BUS_API_EVENT.EMAIL.MENTIONED_IN_POST;
            }
            if (!!eventType) {
              const topicId = parseInt(messageJSON.topicId, 10);
              const postId = messageJSON.postId ? parseInt(messageJSON.postId, 10) : null;

              helperService.getUsersById([notification.userId]).then((users) => {
                logger.debug(`got users ${JSON.stringify(users)}`);
                helperService.getTopic(topicId, logger).then((connectTopic) => {
                  logger.debug(`got topic ${JSON.stringify(connectTopic)}`);
                  const user = users[0];
                  let userEmail = user.email;
                  if (config.ENABLE_DEV_MODE === 'true') {
                    userEmail = config.DEV_MODE_EMAIL;
                  }
                  const recipients = [userEmail];
                  const cc = [];
                  if (notificationType === BUS_API_EVENT.EMAIL.MENTIONED_IN_POST) {
                    cc.push(config.MENTION_EMAIL);
                  }
                  const categories = [`${config.ENV}:${eventType}`];

                  // get jwt token then encode it with base64
                  const body = {
                    userId: parseInt(notification.userId, 10),
                    topicId,
                    userEmail: helper.sanitizeEmail(user.email),
                  };
                  logger.debug(`body for generating token: ${JSON.stringify(body)}`);
                  logger.debug(`authSecret: ${config.authSecret.substring(-5)}`);
                  const token = jwt.sign(body, config.authSecret, { noTimestamp: true }).split('.')[2];
                  logger.debug(`token: ${token}`);

                  const replyTo = `${config.REPLY_EMAIL_PREFIX}+${topicId}/${token}@${config.REPLY_EMAIL_DOMAIN}`;

                  const eventMessage = {
                    data: {
                      name: user.firstName + ' ' + user.lastName,
                      handle: user.handle,
                      topicTitle: connectTopic.title || '',
                      post: helperService.markdownToHTML(messageJSON.postContent),
                      date: (new Date()).toISOString(),
                      projectName: notification.contents.projectName,
                      projectId: messageJSON.projectId,
                      topicId,
                      postId,
                      authorHandle: notification.contents.userHandle,
                    },
                    recipients,
                    replyTo,
                    cc,
                    from: {
                      name: notification.contents.userHandle,
                      email: 'topcoder@connectemail.topcoder.com',//TODO pick from config
                    },
                    categories,
                  };
                  // send event to bus api
                  return service.postEvent({
                    "topic": eventType,
                    "originator": "tc-notifications",
                    "timestamp": (new Date()).toISOString(),
                    "mime-type": "application/json",
                    "payload": eventMessage,
                  }).then(() => {
                    logger.info(`sent ${eventType} event with body ${eventMessage} to bus api`);
                  });
                });
              });
            }
          }
        })
      )))
      // commit offset
      .then(() => consumer.commitOffset({ topic, partition, offset: m.offset }))
      .catch((err) => logger.error(err));
  });

  consumer
    .init()
    .then(() => _.each(_.keys(handlers),
      // add back the ignored topic prefix to use full topic name
      (topicName) => consumer.subscribe(`${config.KAFKA_TOPIC_IGNORE_PREFIX || ''}${topicName}`, dataHandler)))
    .catch((err) => logger.error(err));
}

/**
 * Start the notification server.
 * @param {Object} handlers the handlers
 */
function start(handlers) {
  const app = express();
  app.set('port', config.PORT);

  app.use(cors());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  const apiRouter = express.Router();

  // load all routes
  _.each(require('./routes'), (verbs, url) => {
    _.each(verbs, (def, verb) => {
      const actions = [];
      const method = require('./controllers/' + def.controller)[def.method];
      if (!method) {
        throw new Error(def.method + ' is undefined');
      }
      actions.push((req, res, next) => {
        req.signature = `${def.controller}#${def.method}`;
        next();
      });
      if (url !== '/health') {
        actions.push(jwtAuth());
        actions.push((req, res, next) => {
          if (!req.authUser) {
            return next(new errors.UnauthorizedError('Authorization failed.'));
          }
          req.user = req.authUser;
          return next();
        });
      }
      actions.push(method);
      apiRouter[verb](url, helper.autoWrapExpress(actions));
    });
  });

  app.use(config.API_CONTEXT_PATH, apiRouter);


  app.use((req, res) => {
    res.status(404).json({ error: 'route not found' });
  });


  app.use((err, req, res, next) => { // eslint-disable-line
    logger.logFullError(err, req.signature);
    let status = err.httpStatus || 500;
    if (err.isJoi) {
      status = 400;
    }
    // from express-jwt
    if (err.name === 'UnauthorizedError') {
      status = 401;
    }
    res.status(status);
    if (err.isJoi) {
      res.json({
        error: 'Validation failed',
        details: err.details,
      });
    } else {
      res.json({
        error: err.message,
      });
    }
  });

  models
    .init()
    .then(() => {
      app.listen(app.get('port'), () => {
        logger.info(`Express server listening on port ${app.get('port')}`);
      });

      startKafkaConsumer(handlers);
    })
    .catch((err) => logger.error(err));
}

// Exports
module.exports = {
  start,
};
