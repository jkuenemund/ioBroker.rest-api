![Logo](admin/swagger.png)
# ioBroker swagger adapter

![Number of Installations](http://iobroker.live/badges/swagger-installed.svg) ![Number of Installations](http://iobroker.live/badges/swagger-stable.svg) [![NPM version](http://img.shields.io/npm/v/iobroker.swagger.svg)](https://www.npmjs.com/package/iobroker.swagger)
[![Downloads](https://img.shields.io/npm/dm/iobroker.swagger.svg)](https://www.npmjs.com/package/iobroker.swagger)
[![Tests](https://travis-ci.org/ioBroker/ioBroker.swagger.svg?branch=master)](https://travis-ci.org/ioBroker/ioBroker.swagger)

[![NPM](https://nodei.co/npm/iobroker.swagger.png?downloads=true)](https://nodei.co/npm/iobroker.swagger/)

This is RESTFul interface to read the objects and states from ioBroker and to write/control the states over HTTP Get/Post requests.

![Screenshot](img/screen.png)

## Usage
Call in browser ```http://ipaddress:8093/``` and use Swagger UI to request and modify the states

## Subscribe on state or object changes
Your application could get notifications by every change of the state or object.

For that your application must provide an HTTP(S) end-point to accept the updates.

Example in node.js see here [demoNodeClient.js](examples/demoNodeClient.js)

## Long polling
This adapter supports subscribe on data changes via long polling. 

Example for browser could be found here: [demoNodeClient.js](examples/demoBrowserClient.html)  

## Notice
- `POST` is always for creating a resource ( does not matter if it was duplicated )
- `PUT` is for checking if resource exists then update, else create new resource
- `PATCH` is always for updating a resource

## Changelog
### 0.1.0 (2017-09-14)
* (bluefox) initial commit

## License
Apache 2.0

Copyright (c) 2017-2022 bluefox <dogafox@gmail.com>