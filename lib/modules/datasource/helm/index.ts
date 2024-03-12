import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { cache } from '../../../util/cache/package/decorator';
import type { HttpResponse } from '../../../util/http/types';
import { ensureTrailingSlash } from '../../../util/url';
import { parseSingleYaml } from '../../../util/yaml';
import * as helmVersioning from '../../versioning/helm';
import { Datasource } from '../datasource';
import type { GetReleasesConfig, ReleaseResult } from '../types';
import { findSourceUrl } from './common';
import type { HelmRepository, HelmRepositoryData } from './types';

export class HelmDatasource extends Datasource {
  static readonly id = 'helm';

  constructor() {
    super(HelmDatasource.id);
  }

  override readonly defaultRegistryUrls = ['https://charts.helm.sh/stable'];

  override readonly defaultConfig = {
    commitMessageTopic: 'Helm release {{depName}}',
  };

  override readonly defaultVersioning = helmVersioning.id;

  @cache({
    namespace: `datasource-${HelmDatasource.id}`,
    key: (helmRepository: string) => helmRepository,
  })
  async getRepositoryData(
    helmRepository: string,
  ): Promise<HelmRepositoryData | null> {
    let res: HttpResponse<string>;
    try {
      res = await this.http.get('index.yaml', {
        baseUrl: ensureTrailingSlash(helmRepository),
      });
      if (!res?.body) {
        logger.warn(
          { helmRepository },
          `Received invalid response from helm repository`,
        );
        return null;
      }
    } catch (err) {
      this.handleGenericErrors(err);
    }
    try {
      // TODO: use schema (#9610)
      const doc = parseSingleYaml<HelmRepository>(res.body, {
        json: true,
      });
      if (!is.plainObject<HelmRepository>(doc)) {
        logger.warn(
          { helmRepository },
          `Failed to parse index.yaml from helm repository`,
        );
        return null;
      }
      const result: HelmRepositoryData = {};
      for (const [name, releases] of Object.entries(doc.entries)) {
        if (releases.length === 0) {
          continue;
        }
        const latestRelease = releases[0];
        const sourceUrl = findSourceUrl(latestRelease);
        result[name] = {
          homepage: latestRelease.home,
          sourceUrl,
          releases: releases.map((release) => ({
            version: release.version,
            releaseTimestamp: release.created ?? null,
            // The Helm repository at Gitlab does not include a digest (#24280)
            newDigest: release.digest ?? undefined,
          })),
        };
      }

      return result;
    } catch (err) {
      logger.debug(
        { helmRepository, err },
        `Failed to parse index.yaml from helm repository`,
      );
      return null;
    }
  }

  async getReleases({
    packageName,
    registryUrl: helmRepository,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    // istanbul ignore if
    if (!helmRepository) {
      return null;
    }

    const repositoryData = await this.getRepositoryData(helmRepository);
    if (!repositoryData) {
      logger.debug(`Missing repo data from ${helmRepository}`);
      return null;
    }
    const releases = repositoryData[packageName];
    if (!releases) {
      logger.debug(
        { dependency: packageName },
        `Entry ${packageName} doesn't exist in index.yaml from ${helmRepository}`,
      );
      return null;
    }
    return releases;
  }
}
