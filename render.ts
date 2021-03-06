import {
    MatrixClient,
    SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import {
    readdirSync,
    readFileSync,
    writeFileSync,
    createWriteStream
} from "fs";
import ping from "./ping";
import getProjectInfo from "./getProjectInfo";
const axios = require('axios').default;
const { program } = require('commander');
program
  .option('-d, --debug', 'output all the json blocks, suppress header')
  .option('-s, --summary', 'highlight missing summary blocks')
  .option('-m, --media', 'download and process media')
  .option('-p, --pings', 'get ping-room data')
  .option('-w, --web', 'start a server to render the result');
program.parse(process.argv);
import moment = require('moment');

const homeserverUrl = require("./config/access_token.json").homeserver;
const accessToken = require("./config/access_token.json").accessToken;
const userId = require("./config/access_token.json").userId;
const senders = require("./data/senders.json");
const sections = require("./data/sections.json");
const storage = new SimpleFsStorageProvider("config/twim-o-matic.json");
let testRoomId = "!UpevrrilOuZdxLWcHj:bpulse.org";

const client = new MatrixClient(homeserverUrl, accessToken, storage);

//client.start().then(() => console.log("Client started!"));

const twimRoomId = "!xYvNcQPhnkrdUmYczI:matrix.org";


function getSaidBookism() {
    const saidBookisms = ["said", "announced", "told us", "reported", "offered"];
    return saidBookisms[Math.floor(Math.random() * saidBookisms.length)];
}

function ds() {
    return (new Date()).toISOString().substring(0, 10);
}

function generateSignOff() {
    var title:string = "## That's all I know 🏁";
    const messages = [
        "See you next week, and be sure to stop by [#twim:matrix.org] with your updates!",
        "So that's all I have to say to you right now! See you next week, and be sure to stop by [#twim:matrix.org] with your updates!"
    ];
    const urls = `[#TWIM:matrix.org]: https://matrix.to/#/#TWIM:matrix.org`;
    return `${title}\n\n${messages[0]}\n\n${urls}\n`;
}

function getSectionFromIcon(icon:string) {
    for (let s of Object.keys(sections)) {
        if (sections[s].icon === icon) {
            return s;
        }
    }
}

var output = {};
var pings = "";
var prevSection = "";
var prevSender = "";
var prevEventId = "";

async function getEvent(eventId) {
    var event = await client.getEvent(twimRoomId, eventId);
    return event;
}

async function getUserDisplayname(mxid) {
    let up;
    try {
        up = await client.getUserProfile(mxid)
    } catch (e) {
        up = "TODO MISSING display name for " + mxid;
        console.log(e);
    }
    
    return up;
}

async function handleEvent(event, title, mode, sectionOverride, notes, transforms) {
    let reactions = event.unsigned['m.relations']['m.annotation'].chunk;
    // let considered = Object.values(sections)
    //     .map(function(s:any) { return s.icon });
    // let filtered = reactions.filter(function(r:any) { return considered.includes(r.key) })

    var written = false;

    // first extract the body content
    var body = event.content.body;
    // remove the various TWIM markers
    body = body.replace("TWIM: ", "");
    body = body.replace("TWIM:", "");
    body = body.replace("@twim:cadair.com: ", "");
    body = body.replace("@twim:cadair.com:", "");
    body = body.replace("@twim:cadair.com", "");
    body = body.replace(/^TWIM /gm, "");
    body = body.replace(/^TWIM\n/gm, "");
    body = body.trim();

    // get project info
    var section = 'todo';
    var bodyLower = body.toLowerCase();
    var projectInfo = getProjectInfo(bodyLower);

    // get section
    if (sectionOverride) {
        section = sectionOverride;
    }
    else if (! ["👀", "🧹"].includes(mode)) {
        section = getSectionFromIcon(mode);
        projectInfo.sectionSet = "Section set by mode";
    }
    else if (projectInfo.section) {
        section = projectInfo.section;
    } else {
        // do nothing, leave it as 'todo'
    }
    section = sections[section].title;
    
    // find the score (sum of all reactions)
    const reducer = (accumulator, currentValue) => accumulator + currentValue;
    const score = reactions.map(r => r.count).reduce(reducer);

    // set the title line
    var titleLine:string = "";
    if (body[0] === '#') {
        const bodyLines = body.split('\n');
        titleLine = `### ${bodyLines[0].replace(/\#/g, "").trim()}\n\n`
        bodyLines.shift();
        body = bodyLines.join('\n');
        body = body.trim();
    }
    else if ([sections.thoughts.title, sections.spec.title].includes(section)) {
        titleLine = "";
    }
    else if (projectInfo.project) {
        title = projectInfo.project;
        titleLine = `### ${title}\n\n`;
    } else {
        titleLine = `### ${title} ${score}\n\n`;
    }

    // quoteMode means we give credit and prepend
    var quoteMode = true;
    if (event.sender === userId) {
        quoteMode = false;
    }

    // senderLine depends on the quoteMode
    var senderLine:String = "";
    if (quoteMode) {
        var sender = senders[event.sender];
        if (sender) {
            senderLine = `[${sender.name}]`;
            if (sender.url) {
                senderLine += `(${sender.url})`;
            } else {
                senderLine += `(https://matrix.to/#/${event.sender})`;
            }
        } else {
            senderLine = `TODO CACHE MISSING NAME [${(await getUserDisplayname(event.sender)).displayname}](https://matrix.to/#/${event.sender})`;

        }
        senderLine += ` ${getSaidBookism()}:\n\n`;
    }

    // massage the body text where needed
    if (quoteMode) {
        // prepend each line with a `>`, no space if it's a blank line
        body = body.replace(/^/gm, `> `);
        body = body.replace(/^> *$/gm, ">");
    }

    // * for lists, not -, get over it
    body = body.replace(/^>(( )+)-/gm, ">$1*");

    // fix some missing linebreaks
    body = body.replace(/(^> [^\*](.)+\n)> \*/mg, `$1>\n> *`);

    // add warning to malformed header
    body = body.replace(/(^> )(#+) (.*)/mg, `$1#### $3`);

    // insert missing gapped `>` after quoted headers
    body = body.replace(/(^> #*.*)\n>[^\n]/gm, `$1\n>\n> `);

    // insert matrix.to links for rooms
    const regex = /(#([a-z.-]+):([a-z.-]+)\b)/g;
    const subst = `[$1](https://matrix.to/#/$1)`;
    body = body.replace(regex, subst);

    // trim the lot
    body = body.trim();

    if (["m.video", "m.image"].includes(event.content.msgtype)) {
        if (! program.media) return;
        if (event.content.url) {
            titleLine = "### TODO GET IMAGE\n\n";
            var url = "https://matrix.org/_matrix/media/r0/download/" + event.content.url.replace('mxc://', '');
            var filename = body.replace('> ', '').replace(/ /g, "");
            filename = `${ds()}-${event.event_id.substring(1,6)}-${filename}`;
            downloadImage(url, `blog/img/${filename}`);
            body = `![${filename}](/blog/img/${filename})`;
            if (prevSender === event.sender) {
                output[prevSection][output[prevSection].length-1].content += `\n${body}\n`;
                written = true;
            }
        } else {
            titleLine = `### TODO MEDIA EVENT with missing content.url: ${event.event_id}\n\n`;
        }

    } else {
        prevSection = section;
        prevSender = event.sender;
        prevEventId = event.event_id;
    }

    if (written) return;

    if (!output[section]) output[section] = [];

    var debugText = "";
    if (program.debug) {
        debugText = event.event_id + `\n` + JSON.stringify(projectInfo) + `\n\n`;
    }

    var projectLine:string = "";
    if (projectInfo.summary) {
            projectLine = projectInfo.summary + `\n\n`;
        }
    else if (program.summary) {
        if (! ["status", "synapse-deployment", "projects"].includes(projectInfo.section)) {
            projectLine = `TODO MISSING SUMMARY LINE\n\n`;
        }
    }

    output[section].push({
        score: score,
        content:`${titleLine}${debugText}${projectLine}${senderLine}${body}\n\n${notes?notes:""}\n`,
        event_id: event.event_id,
        notes: notes,
        transforms: transforms
    });
}

async function downloadImage (url, path) {  
    const writer = createWriteStream(path);
  
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    })
  
    response.data.pipe(writer)
  
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve)
      writer.on('error', reject)
    })
}

function generateHeader() {
    if (program.debug) return "";

    return `---
date: '${ds()}'
title: 'This Week in Matrix ${ds()}'
categories:
  - This Week in Matrix
author: Ben Parsons
image: TODO
---\n\n`;
}

function outputAll() {
    var result:string = "";
    result += generateHeader();
    result += `## Matrix Live 🎙\n\n`;
    let separated = [];

    let sortedSections = Object.values(sections).sort((a:any, b:any) => {
        return a.order - b.order;
    });
    sortedSections.forEach((section: any) => {
        result += generateSection(section);

        if (output[section.title]) {
            separated = separated.concat(output[section.title])
        }
    });
    
    result += pings;
    result += generateSignOff();

    // wrap bare urls
    const regex = /([^(])(https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&\/\/=]*))/mg;
    const subst = `$1<$2>`;
    result = result.replace(regex, subst);
    //console.log(result);
    writeFileSync("out.md", result);

    if (program.web) {
        const express = require("express");
        const app = express();
        app.set('view engine', 'pug');
        console.log(output[sections.clients.title])

        app.get('/', function(req, res) {
            res.render('twim', {
                messages: separated
            });
        });
        let port = 9001
        app.listen(port, function() {
            console.log("listening on " + port);
        })
    }
}

async function addNoteToEvent(event_id, note) {
    let eventsToHandle = await client.getRoomStateEvent(testRoomId, "b.twim", "entries");
    let index = eventsToHandle.findIndex(e=> e.events[0] === event_id);
    eventsToHandle[index].notes[0] = note;
    await client.sendStateEvent(testRoomId, "b.twim", "entries", eventsToHandle);
}

function generateSection(section) {
    if (! output[section.title]) return "";

    var result:string = "";
    result += `## ${section.title}\n\n`;
    output[section.title].sort(( a, b ) => a.score > b.score ? -1 : 1 );
    output[section.title].forEach(part => {
        result += `${part.content}\n`;
    });
    return result;
}

async function main() {
    let eventsToHandle = await client.getRoomStateEvent(testRoomId, "b.twim", "entries");
    for (var entry of eventsToHandle.entries) {
        try {
            let event = await getEvent(entry.events[0]);
            entry.transforms.forEach(t => {
                event.content.body = event.content.body.replace(new RegExp(t[0], t[1]))
            });
            await handleEvent(event, "TODO", entry.key, undefined, entry.notes[0], entry.transforms)
        } catch (ex) {
            console.log(ex.body);
            console.log(entry);
        }
    }
    if (program.pings) {
        pings = await ping();
    }
    
    outputAll();
}

main();
