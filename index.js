"use strict"

const bent     = require("bent");
const {Client} = require("tplink-smarthome-api");


const HA_TOKEN = ""
const HOSTS    = ["192.168.1.10",
                  "192.168.1.11",
                  "192.168.1.12"];


async function run()
{
    let home_assistant;
    try
    {
            home_assistant= bent("http://192.168.1.2/api/states/",
                                 "POST",
                                 // "json",
                                 {Authorization: `Bearer ${HA_TOKEN}`},
                                 [200, 201]);
    }
    catch (error)
    {
        console.log(error);
    }
    const kasa_client = new Client();

    const switches = await Promise.all(HOSTS.map(
        async (host) => {
            return await kasa_client.getDevice({host: host})
        }));

    let initial_states = {"on":  0,
                          "off": 0};
    for (const light_switch of switches)
    {
        const info = await light_switch.getSysInfo();
        const switch_state = info.relay_state ? "on" : "off";
        initial_states[switch_state] += 1;
    }

    let state = "off";
    for (const initial_state in initial_states)
    {
        if (initial_states[initial_state] > 1)
        {
            state = initial_state;
            break;
        }
    }
    try
    {
        await home_assistant("binary_sensor.study_lights", {state: state});
    }
    catch (error)
    {
        console.log(error);
    }

    setInterval(
        async() => {
            for (const light_switch of switches)
            {
                const info = await light_switch.getSysInfo();
                const new_state = info.relay_state ? "on" : "off";

                if (new_state != state)
                {
                    state = new_state;
                    try
                    {
                        await home_assistant("binary_sensor.study_lights", {state: state});
                    }
                    catch (error)
                    {
                        console.log(error);
                    }
                    break;
                }
            }
        },
        1000);
}

run();
