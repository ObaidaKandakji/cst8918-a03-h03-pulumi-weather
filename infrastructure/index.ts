import * as pulumi from '@pulumi/pulumi'
import * as azRedis from '@pulumi/azure-native/redis'

import * as resources from '@pulumi/azure-native/resources'
import * as containerregistry from '@pulumi/azure-native/containerregistry'
import * as containerinstance from '@pulumi/azure-native/containerinstance'

import * as dockerBuild from '@pulumi/docker-build'

// Import the configuration settings for the current stack.
const config = new pulumi.Config()

// Azure provider config (this was missing in your file)
const azureConfig = new pulumi.Config('azure-native')
const location = azureConfig.require('location')

const appPath = config.require('appPath')
const prefixName = config.require('prefixName')
const imageName = prefixName
const imageTag = config.require('imageTag')

// Azure container instances (ACI) service does not yet support port mapping
// so, the containerPort and publicPort must be the same
const containerPort = config.requireNumber('containerPort')
const publicPort = config.requireNumber('publicPort')
const cpu = config.requireNumber('cpu')
const memory = config.requireNumber('memory')

// Create a resource group.
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`)

// Create a managed Azure Cache for Redis instance
const redisCache = new azRedis.Redis(`${prefixName}-redis`, {
  name: `${prefixName}-weather-cache`,
  location: location,
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: 'Latest',
  minimumTlsVersion: '1.2',
  redisConfiguration: {
    maxmemoryPolicy: 'allkeys-lru',
  },
  sku: {
    name: azRedis.SkuName.Basic,
    family: azRedis.SkuFamily.C,
    capacity: 0,
  },
})

// Extract the auth key from the deployed Redis service
const redisAccessKey = pulumi.secret(
  azRedis
    .listRedisKeysOutput({
      name: redisCache.name,
      resourceGroupName: resourceGroup.name,
    })
    .apply((keys) => keys.primaryKey),
)

// Construct the Redis connection string for the app
const redisConnectionString =
  pulumi.interpolate`rediss://:${redisAccessKey}@${redisCache.hostName}:${redisCache.sslPort}`

// Create the container registry.
// Make ACR name lowercase to satisfy naming rules.
const acrName = `${prefixName.replace(/-/g, '').toLowerCase()}acr`
const registry = new containerregistry.Registry(acrName, {
  resourceGroupName: resourceGroup.name,
  adminUserEnabled: true,
  sku: {
    name: containerregistry.SkuName.Basic,
  },
})

// Get the authentication credentials for the container registry.
const registryCredentials = containerregistry
  .listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName: registry.name,
  })
  .apply((creds) => {
    return {
      username: creds.username!,
      password: creds.passwords![0].value!,
    }
  })

// Define the container image for the service.
const image = new dockerBuild.Image(`${prefixName}-image`, {
  tags: [pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`],
  context: { location: appPath },
  dockerfile: { location: `${appPath}/Dockerfile` },
  target: 'production',
  platforms: ['linux/amd64', 'linux/arm64'],
  push: true,
  registries: [
    {
      address: registry.loginServer,
      username: registryCredentials.username,
      password: registryCredentials.password,
    },
  ],
})

// Create a container group in Azure Container Instances and make it publicly accessible.
const containerGroup = new containerinstance.ContainerGroup(
  `${prefixName}-container-group`,
  {
    resourceGroupName: resourceGroup.name,
    osType: 'Linux',
    restartPolicy: 'Always',
    imageRegistryCredentials: [
      {
        server: registry.loginServer,
        username: registryCredentials.username,
        password: registryCredentials.password,
      },
    ],
    containers: [
      {
        name: imageName,
        image: image.ref,
        ports: [{ port: containerPort, protocol: 'TCP' }],
        environmentVariables: [
          { name: 'PORT', value: containerPort.toString() },
          { name: 'WEATHER_API_KEY', value: config.requireSecret('weatherApiKey') },
          { name: 'REDIS_URL', value: redisConnectionString },
        ],
        resources: {
          requests: { cpu: cpu, memoryInGB: memory },
        },
      },
    ],
    ipAddress: {
      type: containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: imageName,
      ports: [{ port: publicPort, protocol: 'TCP' }],
    },
  },
  {
    customTimeouts: { create: '30m', update: '30m', delete: '30m' },
  },
)

// Export the service's IP address, hostname, and fully-qualified URL.
export const hostname = containerGroup.ipAddress.apply((addr) => addr!.fqdn!)
export const ip = containerGroup.ipAddress.apply((addr) => addr!.ip!)
export const url = containerGroup.ipAddress.apply(
  (addr) => `http://${addr!.fqdn!}:${containerPort}`,
)
